"""指标聚合：从样本列表计算汇总（含 Goodput）。"""

from __future__ import annotations

from .schemas import SampleRecord, SLO
from .stats import mean_std, percentiles

_LAT_PS = [50, 90, 95, 99, 99.9]


def summarize(
    samples: list[SampleRecord],
    slo: SLO,
    price_in: float = 0.0,
    price_out: float = 0.0,
    price_cache_in: float = 0.0,
) -> dict:
    total = len(samples)
    ok_samples = [s for s in samples if s.ok]
    ok = len(ok_samples)
    success_rate = (ok / total) if total else 0.0

    e2e = [s.e2e_ms for s in ok_samples if s.e2e_ms is not None]
    ttft = [s.ttft_ms for s in ok_samples if s.ttft_ms is not None]
    tpot = [s.tpot_ms for s in ok_samples if s.tpot_ms is not None]
    itl = [s.itl_mean_ms for s in ok_samples if s.itl_mean_ms is not None]
    out_tok = sum(s.out_tokens for s in ok_samples)
    in_tok = sum(s.in_tokens for s in ok_samples)
    cached_tok = sum(s.cached_tokens for s in ok_samples)
    cache_write_tok = sum(s.cache_write_tokens for s in ok_samples)

    # 缓存命中 vs 未命中的 TTFT 对比（主流工具都不做，这里做差异点）
    hit = [s for s in ok_samples if s.cached_tokens > 0 and s.ttft_ms is not None]
    miss = [s for s in ok_samples if not s.cached_tokens and s.ttft_ms is not None]
    hit_ttft = [v for v in (s.ttft_ms for s in hit) if v is not None]
    miss_ttft = [v for v in (s.ttft_ms for s in miss) if v is not None]
    hit_p = percentiles(hit_ttft, [50, 95])
    miss_p = percentiles(miss_ttft, [50, 95])
    hit_mean, _ = mean_std(hit_ttft)
    miss_mean, _ = mean_std(miss_ttft)
    cost_total, _ = _cost(
        in_tok, cached_tok, out_tok, price_in, price_out, price_cache_in
    )

    # Goodput：TTFT 与 E2EL 必须达标；TPOT 仅在可测时参与。
    # 非流式拿不到逐 token 时间，若强制要求 TPOT，健康渠道会被误判为 0%。
    good = 0
    for s in ok_samples:
        if s.ttft_ms is None or s.e2e_ms is None:
            continue
        if s.ttft_ms > slo.ttft_ms or s.e2e_ms > slo.e2e_ms:
            continue
        if s.tpot_ms is not None and s.tpot_ms > slo.tpot_ms:
            continue
        good += 1
    goodput = (good / total) if total else 0.0

    e2e_p = percentiles(e2e, _LAT_PS)
    ttft_p = percentiles(ttft, _LAT_PS)
    tpot_p = percentiles(tpot, [50, 90, 95, 99])
    itl_p = percentiles(itl, [50, 90, 95, 99])

    e2e_mean, e2e_std = mean_std(e2e)
    ttft_mean, ttft_std = mean_std(ttft)
    tpot_mean, _ = mean_std(tpot)

    # 输出 token 速率：sum(tokens)/sum(纯解码时长)
    decode_time_s = (
        sum(
            (s.e2e_ms - s.ttft_ms)
            for s in ok_samples
            if s.e2e_ms is not None and s.ttft_ms is not None
        )
        / 1000.0
    )
    # 解码总时长不足 1 秒时，token 数/时长 会放大成几千 tok/s —— 判为不可计算
    tok_per_s = (
        round(out_tok / decode_time_s, 2)
        if (decode_time_s >= 1.0 and out_tok > 0)
        else None
    )

    wall = 0.0
    ts = [s.ts for s in samples]
    if len(ts) >= 2:
        wall = max(ts) - min(ts)
    # 采样时长不足 1 秒时，总请求数/墙钟 会得出几千 req/s 的荒谬值 —— 判为不可计算
    rps = round(total / wall, 3) if wall >= 1.0 else None
    # vLLM 口径的 goodput 是"每秒达标请求数"，与占比口径一并给出
    request_goodput = round(good / wall, 3) if wall >= 1.0 else None

    errors: dict[str, int] = {}
    for s in samples:
        if not s.ok:
            key = s.error_class or "unknown"
            errors[key] = errors.get(key, 0) + 1

    # 内容级 checks（对齐 k6 checks 思路：传输成功 ≠ 内容有效）
    # ok 但输出 token 为 0，通常是渠道返回 200 却给了空补全（假成功）
    empty_out = sum(1 for s in ok_samples if (s.out_tokens or 0) == 0)

    return {
        "total": total,
        "ok": ok,
        "failed": total - ok,
        "success_rate": round(success_rate, 4),
        "goodput": round(goodput, 4),
        "request_goodput": request_goodput,
        "rps": rps,
        "wall_s": round(wall, 3),
        "checks": {
            "empty_output": empty_out,
            "nonempty_rate": (round(1 - empty_out / ok, 4) if ok else None),
        },
        "e2e": {
            "mean": _r(e2e_mean),
            "std": _r(e2e_std),
            "cv": _r(e2e_std / e2e_mean) if e2e_mean else 0.0,
            **{f"p{p}": _r(v) for p, v in e2e_p.items()},
        },
        "ttft": {
            "mean": _r(ttft_mean),
            "std": _r(ttft_std),
            **{f"p{p}": _r(v) for p, v in ttft_p.items()},
        },
        "tpot": (
            {"mean": _r(tpot_mean), **{f"p{p}": _r(v) for p, v in tpot_p.items()}}
            if tpot
            else {"mean": None, "p50": None, "p90": None, "p95": None, "p99": None}
        ),
        "itl": (
            {f"p{p}": _r(v) for p, v in itl_p.items()}
            if itl
            else {"p50": None, "p90": None, "p95": None, "p99": None}
        ),
        "tokens": {
            "in": in_tok,
            "out": out_tok,
            # 两种行业口径都给：
            #   output_throughput          总输出 token / 墙钟时长  ← 与 vLLM / SGLang 一致
            #   output_throughput_per_user 输出 token / 纯解码时长  ← AIPerf per-user 口径
            "output_throughput": (round(out_tok / wall, 2) if wall >= 1.0 else None),
            "output_throughput_per_user": tok_per_s,
            "out_per_s": tok_per_s,
        },
        "measurable": {
            "ttft": bool(ttft),
            "tpot": bool(tpot),
            "itl": bool(itl),
            "note": "" if tpot else "非流式请求测不到 TPOT/ITL",
        },
        "cost": {
            "total": cost_total,
            "per_req": round(cost_total / ok, 6) if ok else 0.0,
            "price_in": price_in,
            "price_out": price_out,
            "price_cache_in": price_cache_in or price_in,
            "currency": "CNY",
        },
        "cache": {
            "cached_tokens": cached_tok,
            "write_tokens": cache_write_tok,
            "hit_rate": _r(cached_tok / in_tok, 4) if in_tok else 0.0,
            "requests_hit": len(hit),
            "requests_miss": len(miss),
            "ttft_hit": {
                "n": len(hit),
                "mean": _r(hit_mean),
                "p50": _r(hit_p[50]),
                "p95": _r(hit_p[95]),
            },
            "ttft_miss": {
                "n": len(miss),
                "mean": _r(miss_mean),
                "p50": _r(miss_p[50]),
                "p95": _r(miss_p[95]),
            },
            "ttft_speedup": _r(miss_mean / hit_mean, 3)
            if (hit_mean and miss_mean)
            else None,
        },
        "errors": errors,
        "slo": {
            "ttft_ms": slo.ttft_ms,
            "tpot_ms": slo.tpot_ms,
            "e2e_ms": slo.e2e_ms,
            "passed": good,
            "total": total,
        },
    }


def _cost(
    in_tok: int,
    cached_tok: int,
    out_tok: int,
    price_in: float,
    price_out: float,
    price_cache_in: float,
) -> tuple[float, float]:
    """成本：命中的输入按缓存单价算，其余按原价。

    近似口径：Anthropic 的 cache_creation 计正常输入价，DeepSeek 的 miss 不算写入。
    """
    cache_price = price_cache_in or price_in
    uncached = max(0, in_tok - cached_tok)
    total = (
        uncached / 1e6 * price_in
        + cached_tok / 1e6 * cache_price
        + out_tok / 1e6 * price_out
    )
    return round(total, 6), total


def _r(v: float | None, nd: int = 2) -> float:
    return round(float(v or 0.0), nd)
