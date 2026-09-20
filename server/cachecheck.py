"""主动缓存检测（Prompt Cache 主动验证）。

对同一长前缀串行发 N 次请求：第 1 次写缓存（miss），后续应命中（hit）。
对比 miss 与 hit 的 TTFT 得出加速比，并与供应商上报的 cached_tokens 交叉验证，
判定渠道的提示缓存是否真实生效——中转最常见的猫腻（声称支持缓存但实际不加速）
在这里会被暴露。

判定四态（阈值由用户输入驱动，禁止魔法数字）：
  valid       缓存有效：加速比 ≥ 阈值，且命中轮数达标
  suspect     疑似假缓存：上游上报了命中，但 TTFT 没有相应下降
  unreported  未上报：所有成功轮次都没有缓存字段（中转吞 usage / 渠道无缓存）
  error       全部失败，无可判数据

前缀开头注入随机 nonce：保证每次检测都从冷缓存开始（不同检测互不污染），
而 nonce 在单次检测内保持不变，不影响轮间前缀一致性。
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field

import httpx

from . import providers
from .engine import _gen_text
from .schemas import RunConfig, Target, TrafficConfig


@dataclass
class CacheCheckParams:
    rounds: int = 6                  # 总轮数：第 1 轮写入（miss），其余应命中
    prefix_tokens: int = 2048        # 前缀长度；OpenAI 门槛 1024、Anthropic 依模型 2048+
    speedup_threshold: float = 1.5   # 加速比 ≥ 此值才算「缓存有效」
    max_tokens: int = 512            # 思考型模型会先耗预算，太小会导致空输出
    stream: bool = True
    timeout_s: float = 60.0
    proxy: str | None = None
    verify_tls: bool = True

    def sanitized(self) -> "CacheCheckParams":
        p = CacheCheckParams(
            rounds=min(max(int(self.rounds or 6), 2), 20),
            prefix_tokens=min(max(int(self.prefix_tokens or 2048), 64), 65536),
            speedup_threshold=max(float(self.speedup_threshold or 1.5), 1.0),
            max_tokens=min(max(int(self.max_tokens or 512), 1), 4096),
            stream=bool(self.stream),
            timeout_s=min(max(float(self.timeout_s or 60), 5), 300),
            proxy=self.proxy,
            verify_tls=bool(self.verify_tls),
        )
        return p


def _round_dict(seq: int, res: providers.RequestResult) -> dict:
    return {
        "seq": seq,
        "ok": res.ok,
        "status_code": res.status_code,
        "ttft_ms": _rd(res.ttft_ms),
        "e2e_ms": _rd(res.e2e_ms),
        "cached_tokens": res.cached_tokens,
        "cache_write_tokens": res.cache_write_tokens,
        "in_tokens": res.in_tokens,
        "out_tokens": res.out_tokens,
        "error_class": res.error_class,
        "error_msg": res.error_msg,
    }


def _rd(v: float | None) -> float | None:
    return round(v, 1) if v is not None else None


def _median(vals: list[float]) -> float | None:
    """TTFT 用中位数：真实渠道单轮方差大（排队/思考），均值会被一轮离群值带歪。"""
    if not vals:
        return None
    vs = sorted(vals)
    n = len(vs)
    return round((vs[n // 2] if n % 2 else (vs[n // 2 - 1] + vs[n // 2]) / 2), 1)


def _summarize(rounds: list[dict], p: CacheCheckParams) -> dict:
    """判定完全由用户设的阈值驱动，结论附数据依据（DESIGN.md §11）。

    加速比判读用 min 口径（miss 最快 / hit 最快）：思考型模型的 TTFT 含思考时长、
    方差极大，中位数会被一轮长思考拖到阈值下；min 是「预填充节省」的噪声下界。
    中位数仍如实展示，供对照。
    """
    ok_rounds = [r for r in rounds if r["ok"]]
    reported = any(
        r["cached_tokens"] > 0 or r["cache_write_tokens"] > 0 for r in ok_rounds
    )
    hit = [
        r for r in ok_rounds if r["cached_tokens"] > 0 and r["ttft_ms"] is not None
    ]
    miss = [
        r for r in ok_rounds if r["cached_tokens"] == 0 and r["ttft_ms"] is not None
    ]
    ttft_first = rounds[0]["ttft_ms"] if rounds else None
    ttft_miss_med = _median([r["ttft_ms"] for r in miss])
    ttft_hit_med = _median([r["ttft_ms"] for r in hit])
    ttft_miss_min = min((r["ttft_ms"] for r in miss), default=None)
    ttft_hit_min = min((r["ttft_ms"] for r in hit), default=None)
    speedup = None       # 中位口径（展示）
    speedup_min = None   # min 口径（判定）
    if ttft_miss_med and ttft_hit_med:
        speedup = round(ttft_miss_med / ttft_hit_med, 2)
    if ttft_miss_min and ttft_hit_min:
        speedup_min = round(ttft_miss_min / ttft_hit_min, 2)

    expected_hits = max(1, len(ok_rounds) - 1)
    if not ok_rounds:
        verdict = "error"
    elif not reported:
        verdict = "unreported"
    elif (
        speedup_min is not None
        and speedup_min >= p.speedup_threshold
        and len(hit) >= expected_hits
    ):
        verdict = "valid"
    else:
        verdict = "suspect"

    notes: list[str] = []
    if not ok_rounds:
        notes.append("没有成功请求，先排查渠道连通性再测缓存")
    elif not reported:
        notes.append(
            "上游没有返回任何缓存字段：可能是中转吞掉了 usage，或渠道本就不支持提示缓存"
        )
    elif verdict == "valid" and speedup is not None and speedup < p.speedup_threshold:
        notes.append(
            f"缓存已生效（未命中输入 token 显著下降），min 口径加速 {speedup_min}× 达标；"
            f"中位 {speedup}× 偏低是思考/排队噪声所致"
        )
    elif verdict == "suspect" and speedup_min is not None:
        notes.append(
            f"加速比 min {speedup_min}× / 中位 {speedup}× 均低于阈值 {p.speedup_threshold}×："
            "上报了命中但延迟没有相应下降，疑似假缓存；可加大 prefix_tokens 或轮数复核"
        )
    elif verdict == "suspect":
        notes.append("命中轮数不足或缺少可比的 miss 样本，结论仅作趋势参考")
    # 输入一致性：in_tokens 已归一为总输入（OpenAI prompt_tokens 含命中；Anthropic 已加回），
    # 各轮应与首轮一致，偏差大 = 中转截断/改写前缀
    if ok_rounds and reported and ok_rounds[0]["in_tokens"]:
        total0 = ok_rounds[0]["in_tokens"]
        for r in hit:
            if abs(r["in_tokens"] - total0) > total0 * 0.1:
                notes.append("各轮输入 token 数不一致：前缀可能被中转截断或改写，缓存不可比")
                break
    if 0 < len(ok_rounds) < p.rounds:
        notes.append(f"仅 {len(ok_rounds)}/{p.rounds} 轮成功，结论仅作趋势参考")
    return {
        "verdict": verdict,
        "provider_reported": reported,
        "ok_rounds": len(ok_rounds),
        "total_rounds": len(rounds),
        "hit_requests": len(hit),
        "ttft_first": ttft_first,
        "ttft_miss_med": ttft_miss_med,
        "ttft_hit_med": ttft_hit_med,
        "ttft_miss_min": ttft_miss_min,
        "ttft_hit_min": ttft_hit_min,
        "speedup": speedup,
        "speedup_min": speedup_min,
        "speedup_threshold": p.speedup_threshold,
        "notes": notes,
    }


class CacheCheckManager:
    """同步执行：单渠道 rounds × (TTFT+输出) 通常 2–10s，无需 SSE。"""

    def __init__(self, store):
        self.store = store

    async def run(
        self, targets: list[Target], p: CacheCheckParams
    ) -> list[dict]:
        p = p.sanitized()
        out: list[dict] = []
        limits = httpx.Limits(max_connections=4, max_keepalive_connections=2)
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(p.timeout_s, connect=min(30.0, p.timeout_s)),
            limits=limits,
            proxy=p.proxy or None,
            verify=p.verify_tls,
            http2=False,
        ) as client:
            for t in targets:
                try:
                    out.append(await self._run_one(client, t, p))
                except Exception as exc:  # noqa: BLE001
                    out.append(
                        {
                            "check_id": "cc_" + uuid.uuid4().hex[:12],
                            "name": t.name,
                            "provider": t.provider.value,
                            "model": t.model,
                            "base_url": t.base_url,
                            "params": p.__dict__,
                            "rounds": [],
                            "summary": {
                                "verdict": "error",
                                "provider_reported": False,
                                "ok_rounds": 0,
                                "total_rounds": p.rounds,
                                "hit_requests": 0,
                                "ttft_first": None,
                                "ttft_miss_mean": None,
                                "ttft_hit_mean": None,
                                "speedup": None,
                                "speedup_threshold": p.speedup_threshold,
                                "notes": [f"检测执行失败：{exc}"],
                            },
                        }
                    )
        return out

    async def _run_one(
        self, client: httpx.AsyncClient, target: Target, p: CacheCheckParams
    ) -> dict:
        check_id = "cc_" + uuid.uuid4().hex[:12]
        nonce = uuid.uuid4().hex[:8]
        # nonce 放在最前：跨次检测前缀必不同（冷缓存），单次检测内恒定（轮间一致）
        prompt = f"[cache-probe {nonce}] " + _gen_text(p.prefix_tokens)
        messages = [{"role": "user", "content": prompt}]
        in_hint, _est = providers.count_tokens(prompt, target.model)
        cfg = RunConfig(
            targets=[],
            stream=p.stream,
            timeout_s=p.timeout_s,
            proxy=p.proxy or "",
            verify_tls=p.verify_tls,
            traffic=TrafficConfig(
                prompt_mode="custom",
                prompt=prompt,
                max_tokens=p.max_tokens,
                temperature=0.0,
            ),
        )
        rounds: list[dict] = []
        for i in range(p.rounds):
            res = await providers.execute(client, target, cfg, messages, in_hint)
            rounds.append(_round_dict(i + 1, res))
        summary = _summarize(rounds, p)
        record = {
            "check_id": check_id,
            "ts": time.time(),
            "name": target.name,
            "provider": target.provider.value,
            "model": target.model,
            "base_url": target.base_url,
            "base_url_masked": target.base_url,  # 与 store._mask 约定一致
            "params": p.__dict__,
            "rounds": rounds,
            "summary": summary,
        }
        try:
            await self.store.save_cache_check(record)
        except Exception:  # 落库失败不阻断结果返回
            pass
        return record
