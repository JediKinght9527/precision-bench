"""压测引擎：并发 / 定频(CO 修正) / 时长模式、批量多供应商、暂停停止。"""

from __future__ import annotations

import asyncio
import random
import time
import uuid
from collections import deque
from dataclasses import dataclass, field

import httpx

from . import providers
from .metrics import summarize
from .schemas import AlertConfig, RunConfig, RunStatus, SampleRecord, Target
from .store import Store

_CORPUS = (
    "You are a helpful assistant. Please answer the user's question accurately and concisely. "
    "The quick brown fox jumps over the lazy dog. Artificial intelligence is transforming industries. "
    "请用中文回答以下问题，保持专业与简洁。网络延迟、首字延迟与每秒输出 token 数是衡量推理服务的关键指标。"
)


def _gen_text(n_tokens: int) -> str:
    if n_tokens <= 4:
        return "hi"
    out = _CORPUS
    while len(out) < n_tokens * 4:
        out += " " + _CORPUS
    return out[: n_tokens * 4]


def build_messages(cfg: RunConfig, model: str) -> tuple[list[dict], int]:
    tr = cfg.traffic
    prompt = ""
    if tr.prompt_mode == "custom" and tr.prompt:
        prompt = tr.prompt
    else:
        n = tr.input_tokens
        if tr.input_dist.value == "uniform":
            n = random.randint(max(1, n // 2), max(2, n * 2))
        elif tr.input_dist.value == "normal":
            n = max(1, int(random.gauss(n, max(1, n // 4))))
        if tr.prompt_mode == "tiny":
            prompt = "hi"
        else:
            prompt = _gen_text(n)
    if cfg.randomize and not cfg.cache_mode:
        prompt = f"[{uuid.uuid4().hex[:6]}] {prompt}"
    messages = []
    if tr.system_prompt:
        messages.append({"role": "system", "content": tr.system_prompt})
    messages.append({"role": "user", "content": prompt})
    in_tok, _ = providers.count_tokens(prompt, model)
    if tr.system_prompt:
        system_tok, _ = providers.count_tokens(tr.system_prompt, model)
        in_tok += system_tok
    return messages, in_tok


@dataclass
class RunState:
    run_id: str
    cfg: RunConfig
    target: Target
    status: RunStatus = RunStatus.pending
    seq: int = 0
    ok: int = 0
    total: int = 0
    started_at: float | None = None
    ended_at: float | None = None
    samples: deque = field(default_factory=lambda: deque(maxlen=5000))
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    tasks: list[asyncio.Task] = field(default_factory=list)
    active_tasks: set[asyncio.Task] = field(default_factory=set)
    stop_flag: bool = False
    pause_event: asyncio.Event = field(default_factory=asyncio.Event)
    stop_event: asyncio.Event = field(default_factory=asyncio.Event)
    schedule_id: str | None = None
    alert_cfg: AlertConfig | None = None
    error: str = ""
    consecutive_fail: int = 0
    max_consecutive_fail: int = 0
    t0_mono: float = 0.0
    ended_mono: float | None = None
    last_summary_at: float = 0.0
    last_phase: dict | None = None
    event_seq: int = 0
    events: deque = field(default_factory=lambda: deque(maxlen=2000))


KEEP_FINISHED = 40  # 已结束的运行最多在内存里保留多少个（超出按结束时间淘汰）


class Engine:
    def __init__(self, store: Store):
        self.store = store
        self.runs: dict[str, RunState] = {}

    def forget(self, run_id: str) -> None:
        self.runs.pop(run_id, None)

    def _evict(self) -> None:
        """已结束的运行不会无限占用内存（每次运行最多持有 5000 条样本）。"""
        finished = [
            (rid, st)
            for rid, st in self.runs.items()
            if st.status in (RunStatus.done, RunStatus.error, RunStatus.stopped)
        ]
        for rid, _ in (
            sorted(finished, key=lambda kv: kv[1].ended_at or 0)[:-KEEP_FINISHED]
            if len(finished) > KEEP_FINISHED
            else []
        ):
            self.runs.pop(rid, None)

    # ---------- 对外控制 ----------
    async def start_many(
        self,
        cfg: RunConfig,
        schedule_id: str | None = None,
        alert_cfg: AlertConfig | None = None,
    ) -> list[str]:
        """批量：每个 target 一个 run，便于横评叠加。"""
        run_ids = []
        for t in cfg.targets:
            sub = cfg.model_copy(deep=True)
            sub.targets = [t]
            rid = uuid.uuid4().hex[:12]
            state = RunState(
                run_id=rid,
                cfg=sub,
                target=t,
                schedule_id=schedule_id,
                alert_cfg=alert_cfg,
            )
            state.pause_event.set()
            self.runs[rid] = state
            # 记录来源定时任务，否则事后无法区分"手动跑"与"巡检跑"
            await self.store.create_run(rid, sub, schedule_cron=schedule_id)
            state.tasks.append(asyncio.create_task(self._drive(state)))
            run_ids.append(rid)
        await asyncio.sleep(0)
        return run_ids

    def get(self, run_id: str) -> RunState | None:
        return self.runs.get(run_id)

    def stop(self, run_id: str) -> bool:
        st = self.runs.get(run_id)
        if not st or st.status in (RunStatus.done, RunStatus.error, RunStatus.stopped):
            return False
        st.stop_flag = True
        st.pause_event.set()
        st.stop_event.set()
        st.status = RunStatus.stopping
        for task in list(st.active_tasks):
            if not task.done():
                task.cancel()
        self._emit(st, {"type": "status", "status": st.status.value})
        return True

    def pause(self, run_id: str) -> bool:
        st = self.runs.get(run_id)
        if not st or st.status in (
            RunStatus.stopping,
            RunStatus.stopped,
            RunStatus.done,
            RunStatus.error,
        ):
            return False
        st.pause_event.clear()
        st.status = RunStatus.paused
        self._emit(st, {"type": "status", "status": st.status.value})
        return True

    def resume(self, run_id: str) -> bool:
        st = self.runs.get(run_id)
        if not st or st.status != RunStatus.paused:
            return False
        st.pause_event.set()
        st.status = RunStatus.running
        self._emit(st, {"type": "status", "status": st.status.value})
        return True

    async def stop_and_wait(self, run_id: str) -> bool:
        st = self.runs.get(run_id)
        if not st:
            return True
        if st.status in (RunStatus.done, RunStatus.error, RunStatus.stopped):
            return True
        self.stop(run_id)
        tasks = [task for task in st.tasks if not task.done()]
        if tasks:
            _, pending = await asyncio.wait(tasks, timeout=5)
            if pending:
                return False
        return True

    async def shutdown(self) -> None:
        active = [
            st
            for st in self.runs.values()
            if st.status not in (RunStatus.done, RunStatus.error, RunStatus.stopped)
        ]
        for st in active:
            self.stop(st.run_id)
        tasks = [task for st in active for task in st.tasks if not task.done()]
        if tasks:
            _, pending = await asyncio.wait(tasks, timeout=5)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)

    def subscribe(self, run_id: str) -> asyncio.Queue:
        st = self.runs[run_id]
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        st.subscribers.add(q)
        return q

    def replay_since(self, run_id: str, after_id: int) -> list[dict]:
        st = self.runs.get(run_id)
        if not st:
            return []
        return [event for event in st.events if event.get("id", 0) > after_id]

    def unsubscribe(self, run_id: str, q: asyncio.Queue) -> None:
        st = self.runs.get(run_id)
        if st:
            st.subscribers.discard(q)

    # ---------- 内部 ----------
    def _emit(self, st: RunState, event: dict) -> None:
        st.event_seq += 1
        event = {**event, "id": st.event_seq}
        st.events.append(event)
        reliable = event.get("type") in {"summary", "status", "error"}
        for q in list(st.subscribers):
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                if not reliable:
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    try:
                        q.put_nowait({"type": "reset"})
                    except asyncio.QueueFull:
                        pass
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def _client(self, cfg: RunConfig) -> httpx.AsyncClient:
        limits = httpx.Limits(
            max_connections=max(20, cfg.concurrency * 2),
            max_keepalive_connections=0
            if not cfg.connection_reuse
            else max(20, cfg.concurrency * 2),
        )
        # 回环直连：避免 Clash/系统代理截 127.0.0.1 → 502（getproxies 不读例外表）
        from .providers import is_loopback

        urls = [t.base_url for t in (cfg.targets or [])]
        trust = not any(is_loopback(u) for u in urls) if urls else True
        return httpx.AsyncClient(
            timeout=httpx.Timeout(cfg.timeout_s, connect=min(30.0, cfg.timeout_s)),
            limits=limits,
            proxy=cfg.proxy or None,
            verify=cfg.verify_tls,
            http2=False,
            trust_env=trust and cfg.proxy is None,
        )

    async def _drive(self, st: RunState) -> None:
        cfg = st.cfg
        st.status = RunStatus.stopping if st.stop_flag else RunStatus.running
        st.started_at = time.time()
        st.t0_mono = time.perf_counter()
        await self.store.set_status(st.run_id, RunStatus.running)
        self._emit(st, {"type": "status", "status": "running"})
        client = self._client(cfg)
        try:
            if cfg.mode.value == "open":
                await self._run_open(st, client)
            else:
                await self._run_closed(st, client)
        except Exception as exc:  # noqa: BLE001
            # 不能静默吞掉：服务里出问题必须能在日志里看到
            import logging

            logging.getLogger("llmbench.engine").exception(
                "run %s 失败: %s", st.run_id, exc
            )
            st.error = f"{type(exc).__name__}: {exc}"
            self._emit(st, {"type": "error", "message": str(exc)})
            st.status = RunStatus.error
        finally:
            try:
                await client.aclose()
            except Exception as exc:  # noqa: BLE001
                st.status = RunStatus.error
                st.error = f"{type(exc).__name__}: {exc}"
        try:
            st.ended_at = time.time()
            st.ended_mono = time.perf_counter()
            self._evict()
            summary = await self._final_summary(st)
            await self.store.set_summary(st.run_id, summary)
            if st.status is RunStatus.error:
                pass
            elif st.stop_flag:
                st.status = RunStatus.stopped
            elif st.status not in (RunStatus.error, RunStatus.stopping):
                st.status = RunStatus.done
            if st.alert_cfg is not None:
                await self._evaluate_alert(st, summary)
            await self.store.set_status(st.run_id, st.status, ended=True)
            self._emit(st, {"type": "summary", "final": True, "data": summary})
            self._emit(st, {"type": "status", "status": st.status.value})
        except Exception as exc:  # noqa: BLE001
            st.status = RunStatus.error
            st.error = f"{type(exc).__name__}: {exc}"
            try:
                await self.store.set_status(st.run_id, st.status, ended=True)
            except Exception:
                pass
            self._emit(st, {"type": "error", "message": st.error})
            self._emit(st, {"type": "status", "status": st.status.value})

    async def _fire(
        self,
        st: RunState,
        client: httpx.AsyncClient,
        scheduled_mono: float | None,
        retry_no: int = 0,
        warmup: bool = False,
    ) -> SampleRecord:
        cfg = st.cfg
        target = st.target
        messages, in_tok = build_messages(cfg, target.model)
        send_mono = time.perf_counter()
        # 预热只用于建立连接/确认可用，不该用完整超时把界面卡住
        tmo = min(cfg.timeout_s, 20.0) if warmup else None
        task = asyncio.current_task()
        if task is not None and task not in st.tasks:
            st.active_tasks.add(task)
        try:
            res = await providers.execute(
                client, target, cfg, messages, in_tok, timeout=tmo
            )
        finally:
            if task is not None:
                st.active_tasks.discard(task)
        arrive = time.perf_counter()
        st.seq += 1
        observed = (arrive - send_mono) * 1000
        corrected = (arrive - scheduled_mono) * 1000 if scheduled_mono else observed
        rec = SampleRecord(
            run_id=st.run_id,
            target=target.name,
            seq=st.seq,
            ts=time.time(),
            scheduled_ts=scheduled_mono,
            send_ts=send_mono,
            dns_ms=res.dns_ms,
            tcp_ms=res.tcp_ms,
            tls_ms=res.tls_ms,
            ttft_ms=res.ttft_ms,
            e2e_ms=res.e2e_ms,
            observed_e2e_ms=observed,
            corrected_e2e_ms=corrected,
            tpot_ms=res.tpot_ms,
            itl_mean_ms=res.itl_mean_ms,
            itl_p99_ms=res.itl_p99_ms,
            out_tokens=res.out_tokens,
            in_tokens=res.in_tokens,
            cached_tokens=res.cached_tokens,
            cache_write_tokens=res.cache_write_tokens,
            cache_reported=res.cache_reported,
            tokens_estimated=res.tokens_estimated,
            status_code=res.status_code,
            ok=res.ok,
            retry_no=retry_no,
            error_class=res.error_class,
            error_msg=res.error_msg,
            bytes_rx=res.bytes_rx,
            conn_reused=res.conn_reused,
        )
        return rec

    async def _handle(
        self, st: RunState, client: httpx.AsyncClient, scheduled_mono: float | None
    ) -> None:
        cfg = st.cfg
        rec = await self._fire(st, client, scheduled_mono)
        # 重试（可选）
        attempt = 0
        while (
            cfg.retries > 0
            and not rec.ok
            and attempt < cfg.retries
            and not st.stop_flag
        ):
            attempt += 1
            backoff = (2**attempt) * 0.2 * (0.5 + random.random())
            await asyncio.sleep(backoff)
            rec = await self._fire(st, client, scheduled_mono, retry_no=attempt)
        st.total += 1
        if rec.ok:
            st.ok += 1
            st.consecutive_fail = 0
        else:
            st.consecutive_fail += 1
            st.max_consecutive_fail = max(st.max_consecutive_fail, st.consecutive_fail)
        st.samples.append(rec)
        await self.store.enqueue(rec)
        self._emit(
            st,
            {
                "type": "sample",
                "data": {
                    "seq": rec.seq,
                    "ts": rec.ts,
                    "target": rec.target,
                    "ttft_ms": rec.ttft_ms,
                    "e2e_ms": rec.e2e_ms,
                    "observed_e2e_ms": rec.observed_e2e_ms,
                    "corrected_e2e_ms": rec.corrected_e2e_ms,
                    "tpot_ms": rec.tpot_ms,
                    "itl_mean_ms": rec.itl_mean_ms,
                    "out_tokens": rec.out_tokens,
                    "in_tokens": rec.in_tokens,
                    "ok": rec.ok,
                    "error_class": rec.error_class,
                    "status_code": rec.status_code,
                },
            },
        )
        # 运行中周期推 live summary（≥1s 节流），否则 KPI/判定/顶栏要等结束才动
        now = time.monotonic()
        if st.samples and now - st.last_summary_at >= 1.0:
            st.last_summary_at = now
            try:
                self._emit(
                    st,
                    {"type": "summary", "live": True, "data": self.live_summary(st)},
                )
            except Exception:  # noqa: BLE001 — 汇总失败不该打断压测
                pass

    async def _run_closed(self, st: RunState, client: httpx.AsyncClient) -> None:
        cfg = st.cfg
        await self._warmup(st, client)
        st.t0_mono = time.perf_counter()
        if cfg.mode.value == "duration":
            await self._run_duration(st, client)
            return
        counter = {"n": 0}
        lock = asyncio.Lock()

        async def worker(worker_index: int):
            if cfg.ramp_rate > 0 and worker_index:
                try:
                    await asyncio.wait_for(
                        st.stop_event.wait(), timeout=worker_index / cfg.ramp_rate
                    )
                except asyncio.TimeoutError:
                    pass
            while not st.stop_flag:
                async with lock:
                    if counter["n"] >= cfg.request_count:
                        return
                    counter["n"] += 1
                await st.pause_event.wait()
                if st.stop_flag:
                    return
                await self._handle(st, client, None)

        await asyncio.gather(
            *[asyncio.create_task(worker(i)) for i in range(max(1, cfg.concurrency))],
            return_exceptions=True,
        )

    async def _run_duration(self, st: RunState, client: httpx.AsyncClient) -> None:
        cfg = st.cfg
        end = time.perf_counter() + cfg.duration_s
        sem = asyncio.Semaphore(max(1, cfg.concurrency))
        counter = {"n": 0}
        lock = asyncio.Lock()

        async def worker():
            while not st.stop_flag and time.perf_counter() < end:
                elapsed = time.perf_counter() - st.t0_mono
                # ramp 阶段线性提升可用并发
                if cfg.ramp_s > 0 and elapsed < cfg.ramp_s:
                    ratio = elapsed / cfg.ramp_s
                    allowed = max(1, int(cfg.concurrency * ratio))
                    if sem._value > allowed:  # noqa: SLF001
                        try:
                            await asyncio.wait_for(st.stop_event.wait(), timeout=0.2)
                        except asyncio.TimeoutError:
                            pass
                        if st.stop_flag:
                            return
                        continue
                phase = "steady"
                if cfg.ramp_s > 0 and elapsed < cfg.ramp_s:
                    phase = "ramp"
                if cfg.cooldown_s > 0 and time.perf_counter() > end - cfg.cooldown_s:
                    phase = "cooldown"
                async with lock:
                    counter["n"] += 1
                await st.pause_event.wait()
                async with sem:
                    if st.stop_flag or time.perf_counter() >= end:
                        return
                    await self._handle(st, client, None)
                    _ = phase

        await asyncio.gather(
            *[asyncio.create_task(worker()) for _ in range(max(1, cfg.concurrency))],
            return_exceptions=True,
        )

    def _emit_phase(self, st: RunState, ev: dict) -> None:
        st.last_phase = ev
        self._emit(st, ev)

    async def _warmup(self, st: RunState, client: httpx.AsyncClient) -> None:
        cfg = st.cfg
        n = max(1, int(cfg.warmup)) if cfg.cache_mode else max(0, int(cfg.warmup))
        if n <= 0:
            return
        self._emit_phase(
            st, {"type": "phase", "phase": "warmup", "done": 0, "total": n}
        )
        for i in range(n):
            if st.stop_flag:
                return
            task = asyncio.create_task(self._fire(st, client, None, warmup=True))
            st.active_tasks.add(task)
            try:
                await task
            except asyncio.CancelledError:
                return
            finally:
                st.active_tasks.discard(task)
            self._emit_phase(
                st, {"type": "phase", "phase": "warmup", "done": i + 1, "total": n}
            )
        self._emit_phase(st, {"type": "phase", "phase": "steady"})

    async def _run_open(self, st: RunState, client: httpx.AsyncClient) -> None:
        cfg = st.cfg
        await self._warmup(st, client)
        rate = max(0.01, cfg.rate)
        st.t0_mono = time.perf_counter()
        period = 1.0 / rate
        n_total = int(rate * cfg.duration_s) if cfg.duration_s > 0 else int(rate * 60)
        sem = asyncio.Semaphore(max(1, cfg.concurrency))
        start = st.t0_mono
        tasks: list[asyncio.Task] = []

        async def one(i: int):
            scheduled = start + i * period
            if cfg.jitter > 0:
                scheduled += random.uniform(-cfg.jitter, cfg.jitter) * period
            now = time.perf_counter()
            if scheduled > now:
                try:
                    await asyncio.wait_for(
                        st.stop_event.wait(), timeout=scheduled - now
                    )
                except asyncio.TimeoutError:
                    pass
            if st.stop_flag:
                return
            await st.pause_event.wait()
            if st.stop_flag:
                return
            async with sem:
                if st.stop_flag:
                    return
                await self._handle(st, client, scheduled)

        for i in range(n_total):
            if st.stop_flag:
                break
            tasks.append(asyncio.create_task(one(i)))
            # 控制任务膨胀
            if len(tasks) > 2000:
                done, pending = await asyncio.wait(
                    tasks, return_when=asyncio.FIRST_COMPLETED
                )
                tasks = list(pending)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _final_summary(self, st: RunState) -> dict:
        await self.store.flush()
        rows = await self.store.get_samples(st.run_id)
        samples = [_row_to_sample(r) for r in rows]
        if not samples:
            samples = list(st.samples)
        summary = summarize(
            samples,
            st.cfg.slo,
            st.cfg.price_in,
            st.cfg.price_out,
            st.cfg.price_cache_in,
            st.cfg.price_cache_write,
            wall_s=(st.ended_mono or time.perf_counter()) - st.t0_mono,
        )
        summary["sample_scope"] = "full"
        return summary

    def live_summary(self, st: RunState) -> dict:
        summary = summarize(
            list(st.samples),
            st.cfg.slo,
            st.cfg.price_in,
            st.cfg.price_out,
            st.cfg.price_cache_in,
            st.cfg.price_cache_write,
            wall_s=max(0.0, time.perf_counter() - st.t0_mono),
        )
        summary["sample_scope"] = "recent"
        summary["sample_limit"] = st.samples.maxlen
        return summary

    async def _evaluate_alert(self, st: RunState, summary: dict) -> None:
        from . import notifier

        a = st.alert_cfg
        if a is None:
            return
        triggered: list[str] = []
        if (
            a.min_success_rate is not None
            and summary["success_rate"] < a.min_success_rate
        ):
            triggered.append(
                f"成功率 {summary['success_rate']:.2%} < {a.min_success_rate:.2%}"
            )
            await self.store.add_alert(
                st.run_id,
                "success_rate",
                "success_rate",
                a.min_success_rate,
                summary["success_rate"],
            )
        if a.max_ttft_ms is not None and summary["ttft"]["p95"] > a.max_ttft_ms:
            triggered.append(f"TTFT P95 {summary['ttft']['p95']}ms > {a.max_ttft_ms}ms")
            await self.store.add_alert(
                st.run_id, "ttft_p95", "ttft_p95", a.max_ttft_ms, summary["ttft"]["p95"]
            )
        if a.max_e2e_ms is not None and summary["e2e"]["p95"] > a.max_e2e_ms:
            triggered.append(f"E2E P95 {summary['e2e']['p95']}ms > {a.max_e2e_ms}ms")
            await self.store.add_alert(
                st.run_id, "e2e_p95", "e2e_p95", a.max_e2e_ms, summary["e2e"]["p95"]
            )
        if (
            a.consecutive_failures is not None
            and st.max_consecutive_fail >= a.consecutive_failures
        ):
            triggered.append(
                f"连续失败 {st.max_consecutive_fail} 次 ≥ {a.consecutive_failures}"
            )
            await self.store.add_alert(
                st.run_id,
                "consecutive_failures",
                "consecutive_failures",
                a.consecutive_failures,
                st.max_consecutive_fail,
            )
        if triggered and a.webhook_url and a.webhook_kind != "none":
            text = f"【Precision Bench 告警】{st.cfg.name} / {st.target.name}\n" + "\n".join(
                f"- {t}" for t in triggered
            )
            await notifier.send(a.webhook_url, a.webhook_kind, text)


def _row_to_sample(r: dict) -> SampleRecord:
    return SampleRecord(
        run_id=r["run_id"],
        target=r["target"],
        seq=r["seq"],
        ts=r["ts"],
        scheduled_ts=r.get("scheduled_ts"),
        send_ts=r.get("send_ts"),
        dns_ms=r.get("dns_ms"),
        tcp_ms=r.get("tcp_ms"),
        tls_ms=r.get("tls_ms"),
        ttft_ms=r.get("ttft_ms"),
        e2e_ms=r.get("e2e_ms"),
        observed_e2e_ms=r.get("observed_e2e_ms"),
        corrected_e2e_ms=r.get("corrected_e2e_ms"),
        tpot_ms=r.get("tpot_ms"),
        itl_mean_ms=r.get("itl_mean_ms"),
        itl_p99_ms=r.get("itl_p99_ms"),
        out_tokens=r.get("out_tokens") or 0,
        in_tokens=r.get("in_tokens") or 0,
        cached_tokens=r.get("cached_tokens") or 0,
        cache_write_tokens=r.get("cache_write_tokens") or 0,
        cache_reported=bool(r.get("cache_reported")),
        tokens_estimated=bool(r.get("tokens_estimated")),
        status_code=r.get("status_code"),
        ok=bool(r.get("ok")),
        retry_no=r.get("retry_no") or 0,
        error_class=r.get("error_class"),
        error_msg=r.get("error_msg"),
        bytes_rx=r.get("bytes_rx") or 0,
        conn_reused=None
        if r.get("conn_reused") is None
        else bool(r.get("conn_reused")),
    )
