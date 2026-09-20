"""降智检测运行器：跑题集、自动判分、指纹、基线对比、SSE 进度。"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

from . import bench_data
from .schemas import Provider, Target
from .store import Store


@dataclass
class BenchState:
    run_id: str
    target: Target
    opts: dict[str, Any]
    status: str = "pending"
    items: list[dict] = field(default_factory=list)
    results: list[dict] = field(default_factory=list)
    dims_done: dict[str, list[int]] = field(default_factory=dict)
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    scores: dict[str, Any] = field(default_factory=dict)
    comparison: dict[str, Any] = field(default_factory=dict)
    fingerprint: str = ""
    fp_texts: list[str] = field(default_factory=list)
    lm_eval_version: str | None = None
    lm_eval_meta: dict | None = None
    dim_meta: dict[str, Any] = field(default_factory=dict)
    started_at: float | None = None
    ended_at: float | None = None
    task: asyncio.Task | None = None


KEEP_FINISHED = 40


class BenchManager:
    def __init__(self, store: Store):
        self.store = store
        self.runs: dict[str, BenchState] = {}

    def forget(self, rid: str) -> None:
        self.runs.pop(rid, None)

    def _evict(self) -> None:
        done = [(rid, st) for rid, st in self.runs.items()
                if st.status in ("done", "error", "stopped")]
        if len(done) <= KEEP_FINISHED:
            return
        for rid, _ in sorted(done, key=lambda kv: kv[1].ended_at or 0)[:-KEEP_FINISHED]:
            self.runs.pop(rid, None)

    def get(self, rid: str) -> BenchState | None:
        return self.runs.get(rid)

    async def start(self, targets: list[Target], opts: dict[str, Any]) -> list[str]:
        engine = opts.get("engine", "curated")
        if engine == "lm_eval":
            from . import lm_eval_runner as L

            dims = [d for d in (opts.get("dims") or L.DEFAULT_TASKS) if d in L.TASKS]
            if not dims:
                raise ValueError("没有可用的官方任务")
            # 官方任务的 limit 是"每个叶子任务"生效（MMLU 有 57 个），必须如实告知
            leaves = sum(L.TASKS[d].get("leaves", 1) for d in dims)
            n_items = leaves * int(opts.get("limit", 200))
            items: list[dict] = []
        else:
            dims = opts.get("dims") or list(bench_data.DIMENSIONS.keys())
            dims = [d for d in dims if d in bench_data.DIMENSIONS]
            items = bench_data.build_items(dims, int(opts.get("needle_tokens", 4000)))
            n_items = len(items)
        ids = []
        for t in targets:
            rid = uuid.uuid4().hex[:12]
            st = BenchState(run_id=rid, target=t, opts={**opts, "dims": dims, "engine": engine}, items=items)
            self.runs[rid] = st
            await self.store.create_bench_run(rid, t, {**opts, "engine": engine}, n_items)
            st.task = asyncio.create_task(self._drive(st))
            ids.append(rid)
        return ids

    def stop(self, rid: str) -> bool:
        st = self.runs.get(rid)
        if not st:
            return False
        st.status = "stopping"
        if st.task:
            st.task.cancel()
        return True

    def subscribe(self, rid: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=2000)
        self.runs[rid].subscribers.add(q)
        return q

    def unsubscribe(self, rid: str, q: asyncio.Queue) -> None:
        st = self.runs.get(rid)
        if st:
            st.subscribers.discard(q)

    def _emit(self, st: BenchState, event: dict) -> None:
        for q in list(st.subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def _client(self, opts: dict) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            timeout=httpx.Timeout(float(opts.get("timeout_s", 120)), connect=30.0),
            limits=httpx.Limits(max_connections=8),
            proxy=opts.get("proxy") or None,
            verify=bool(opts.get("verify_tls", True)),
        )

    async def _drive(self, st: BenchState) -> None:
        """分派：自建题集（curated）或官方数据集（lm_eval），收尾逻辑共用。"""
        st.status = "running"
        st.started_at = time.time()
        await self.store.set_bench_status(st.run_id, "running")
        self._emit(st, {"type": "status", "status": "running"})
        try:
            if st.opts.get("engine") == "lm_eval":
                await self._run_lm_eval(st)
            else:
                await self._run_curated(st)
        except asyncio.CancelledError:
            st.status = "stopped"
        except Exception as exc:  # noqa: BLE001
            import logging

            logging.getLogger("llmbench.bench").exception("bench %s 失败: %s", st.run_id, exc)
            st.status = "error"
            self._emit(st, {"type": "error", "message": str(exc)})
        await self._finish(st)

    async def _run_curated(self, st: BenchState) -> None:
        from .schemas import RunConfig, TrafficConfig
        from . import providers

        opts = st.opts
        cfg = RunConfig(
            targets=[],
            stream=False,
            timeout_s=float(opts.get("timeout_s", 120)),
            proxy=opts.get("proxy"),
            verify_tls=bool(opts.get("verify_tls", True)),
            traffic=TrafficConfig(
                prompt_mode="custom",
                prompt="",
                max_tokens=int(opts.get("max_tokens", 512)),
                temperature=float(opts.get("temperature", 0.0)),
            ),
        )
        max_tokens = int(opts.get("max_tokens", 512))
        client = self._client(opts)
        try:
            total = len(st.items)
            for i, item in enumerate(st.items):
                if st.status == "stopping":
                    break
                messages = [{"role": "user", "content": item["q"]}]
                cfg.traffic.max_tokens = max_tokens
                res = await providers.execute(client, st.target, cfg, messages, 1)
                if res.ok:
                    passed, detail = bench_data.grade(item["g"], res.text)
                else:
                    passed, detail = (False, f"{res.error_class}: {res.error_msg or ''}")
                rec = {
                    "dim": item["dim"],
                    "item_id": item["id"],
                    "passed": passed,
                    "latency_ms": round(res.e2e_ms or 0, 1),
                    "detail": detail,
                    "got": (res.text or "")[:800],
                    "expected": str(item["g"].get("answer") or item["g"].get("value") or "")[:120],
                    "error": None if res.ok else (res.error_class or "error"),
                }
                st.results.append(rec)
                st.dims_done.setdefault(item["dim"], []).append(1 if passed else 0)
                if item["dim"] in ("knowledge", "chinese", "math", "format", "code"):
                    st.fp_texts.append(res.text or "")
                self._emit(st, {"type": "item", "data": {
                    k: rec[k] for k in ("dim", "item_id", "passed", "latency_ms", "detail")}})
                self._emit(st, {"type": "progress", "done": i + 1, "total": total,
                                "ok": sum(r["passed"] for r in st.results)})
        finally:
            await client.aclose()

    async def _run_lm_eval(self, st: BenchState) -> None:
        """跑官方数据集（lm-eval 子进程），逐题结果归一成与自建集相同的结构。"""
        from . import lm_eval_runner as L

        if not L.available():
            raise RuntimeError("未安装 lm-eval，请执行：uv add \"lm_eval[api]\"")
        tasks = [d for d in st.opts.get("dims", []) if d in L.TASKS]
        if not tasks:
            raise RuntimeError("没有可用的官方任务")

        def on_event(ev: dict) -> None:
            self._emit(st, ev)
            if ev.get("state") == "progress":
                self._emit(st, {"type": "progress", "done": ev.get("percent", 0), "total": 100,
                                "ok": sum(1 for r in st.results if r["passed"]), "task": ev.get("task")})

        parsed = await L.run(
            st.target, tasks, st.opts, st.run_id,
            on_event, lambda: st.status == "stopping",
        )

        # 维度元信息（用于图表显示官方任务名，而不是自建维度的名字）
        st.dim_meta = parsed["dims"]
        for dim, d in parsed["dims"].items():
            st.dims_done.setdefault(dim, []).extend([1] * d["passed"] + [0] * (d["n"] - d["passed"]))
        for it in parsed["items"]:
            rec = {**it, "latency_ms": 0.0}
            st.results.append(rec)
            if it["dim"] in ("knowledge", "chinese", "math", "format", "code"):
                st.fp_texts.append(it.get("got") or "")
            self._emit(st, {"type": "item", "data": {
                "dim": rec["dim"], "item_id": rec["item_id"], "passed": rec["passed"],
                "latency_ms": 0.0, "detail": rec.get("detail", "")}})
        st.lm_eval_meta = parsed.get("config")
        st.lm_eval_version = parsed.get("lm_eval_version")
        self._emit(st, {"type": "progress", "done": len(st.results),
                        "total": len(st.results), "ok": sum(1 for r in st.results if r["passed"])})

    async def _finish(self, st: BenchState) -> None:
        scores = self._score(st)
        st.scores = scores
        st.fingerprint = bench_data.fingerprint(st.fp_texts) if st.fp_texts else ""
        comparison = await self._compare_to_baseline(st, scores)
        st.comparison = comparison
        scores["comparison"] = comparison
        scores["fingerprint"] = st.fingerprint
        if getattr(st, "lm_eval_meta", None):
            scores["lm_eval"] = st.lm_eval_meta
            await self.store.update_bench_meta(st.run_id, {
                "lm_eval_version": getattr(st, "lm_eval_version", None),
                "fewshot": (st.lm_eval_meta or {}).get("fewshot"),
            })
        await self.store.finish_bench_run(
            st.run_id, scores, st.fingerprint,
            [{"dim": r["dim"], "item_id": r["item_id"], "passed": r["passed"],
              "latency_ms": r["latency_ms"], "detail": r["detail"],
              "got": r["got"], "expected": r["expected"]} for r in st.results],
        )
        if st.status not in ("error", "stopped"):
            st.status = "done"
        st.ended_at = time.time()
        self._evict()
        await self.store.set_bench_status(st.run_id, st.status)
        self._emit(st, {"type": "summary", "data": {
            **scores, "fingerprint": st.fingerprint, "comparison": comparison}})
        self._emit(st, {"type": "status", "status": st.status})

    def _score(self, st: BenchState) -> dict[str, Any]:
        from .stats_ext import wilson_ci

        dims: dict[str, dict[str, Any]] = {}
        for dim, arr in st.dims_done.items():
            meta = bench_data.DIMENSIONS.get(dim, {})
            em = st.dim_meta.get(dim, {})          # 官方任务自带的元信息
            passed, total = sum(arr), len(arr)
            _, lo, hi = wilson_ci(passed, total)
            dims[dim] = {
                "name": em.get("name") or meta.get("name", dim),
                "bench": em.get("bench") or meta.get("bench", ""),
                "task": em.get("task"),
                "metric": em.get("metric"),
                "stderr": em.get("stderr"),
                "leaves": em.get("leaves"),
                "logprobs_required": em.get("logprobs_required", False),
                "passed": passed,
                "total": total,
                "score": round(passed / total, 4) if total else 0.0,
                "ci_low": round(lo, 4),
                "ci_high": round(hi, 4),
            }
        # 自洽性：同题两答是否一致
        consistency_match = None
        pair_map: dict[str, list[str]] = {}
        for item, rec in zip(st.items, st.results):
            p = item.get("pair")
            if p:
                pair_map.setdefault(p, []).append(
                    bench_data._norm_nospace(rec.get("got", ""))
                )
        if pair_map:
            matched = sum(1 for v in pair_map.values() if len(v) == 2 and v[0] == v[1])
            consistency_match = round(matched / len(pair_map), 4)
        values = [d["score"] for d in dims.values()]
        total = round(sum(values) / len(values), 4) if values else 0.0
        completed = len(st.results)
        return {
            "dims": dims,
            "total": total,
            # 官方数据集没有本地题表，用实跑条目数
            "n_items": len(st.items) or len(st.results),
            "completed": completed,
            "consistency_match": consistency_match,
        }

    def _task_key(self, st: BenchState) -> str:
        """题集标识：引擎 + 排序后的维度/任务。

        基线必须按题集隔离，否则"轻量集 57 题"和"官方 MMLU"会互相覆盖，
        判定会大面积误报。
        """
        engine = st.opts.get("engine", "curated")
        dims = sorted(st.opts.get("dims", []))
        return f"{engine}:" + ",".join(dims)

    async def _baseline_items(self, run_id: str) -> dict[str, bool]:
        """取某次运行的逐题对错，用于配对检验。"""
        rows = await self.store.get_bench_items(run_id)
        return {str(r["item_id"]): bool(r["passed"]) for r in rows}

    async def _compare_to_baseline(
        self, st: BenchState, scores: dict
    ) -> dict[str, Any]:
        from .stats_ext import evaluate

        alpha = float(st.opts.get("alpha", 0.05))
        min_delta = float(st.opts.get("min_delta", st.opts.get("threshold", 0.03)))
        task_key = self._task_key(st)
        base = await self.store.get_baseline(st.target.base_url, st.target.model, task_key)

        if not base or base["bench_run_id"] == st.run_id:
            await self.store.set_baseline(
                st.target.base_url, st.target.model, task_key,
                st.run_id, scores.get("total", 0.0), st.fingerprint,
            )
            return {
                "verdict": "baseline",
                "task_key": task_key,
                "alpha": alpha,
                "min_delta": min_delta,
                "note": "已记录为基线，下次检测将与之对比",
            }

        base_scores = base.get("scores") or {}
        base_dims = base_scores.get("dims", {})
        delta = round(scores.get("total", 0.0) - (base.get("total_score") or 0.0), 4)
        dim_deltas = {
            k: round(v["score"] - base_dims[k]["score"], 4)
            for k, v in scores.get("dims", {}).items() if k in base_dims
        }

        cur_items = {str(r["item_id"]): bool(r["passed"]) for r in st.results}
        base_items = await self._baseline_items(base["bench_run_id"])
        stat = evaluate(base_items, cur_items, alpha=alpha, min_delta=min_delta)
        # 总分口径仍给出阈值触发的维度，便于逐维度定位
        flag_dims = [k for k, d in dim_deltas.items() if d <= -max(min_delta, 0.0)]

        fp_changed = bool(
            st.fingerprint and base.get("fingerprint")
            and st.fingerprint != base["fingerprint"]
        )
        return {
            "verdict": stat["verdict"],
            "task_key": task_key,
            "threshold": min_delta,
            "alpha": alpha,
            "min_delta": min_delta,
            # 统计量（前端展示用）
            "p_value": stat.get("p_value"),
            "significant": stat.get("significant"),
            "test": stat.get("test"),
            "paired": stat.get("paired"),
            "n_paired": stat.get("n_paired"),
            "n_baseline": stat.get("n_baseline"),
            "n_current": stat.get("n_current"),
            "ci95": stat.get("ci95"),
            "baseline_ci95": stat.get("baseline_ci95"),
            "discordant": stat.get("discordant"),
            "stat_note": stat.get("note"),
            # 兼容既有前端字段
            "baseline_total": base.get("total_score"),
            "baseline_ts": base.get("ts"),
            "baseline_run_id": base["bench_run_id"],
            "delta": delta,
            "dim_deltas": dim_deltas,
            "flag_dims": flag_dims,
            "fingerprint_changed": fp_changed,
        }
