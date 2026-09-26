"""LLM 中转 API 性能测试平台 — 后端入口。"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import bench_data
from .bench import BenchManager
from .cachecheck import CacheCheckManager, CacheCheckParams
from .engine import Engine, _row_to_sample
from .metrics import summarize
from .parse import parse_paste
from .scheduler import SchedulerManager
from .schemas import (
    RunConfig,
    RunStatus,
    ScheduleConfig,
    SLO,
    Target as TargetModel,
    TrafficConfig,
)
from .stats import lttb
from .store import Store, _mask

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"


def _build_stamp() -> str:
    """用前端静态文件的最后修改时间生成构建戳，用于防缓存。"""
    import hashlib

    h = hashlib.sha1()
    for f in (
        sorted(WEB.glob("*.js")) + sorted(WEB.glob("*.css")) + [WEB / "index.html"]
    ):
        try:
            h.update(f"{f.name}:{f.stat().st_mtime_ns}".encode())
        except OSError:
            pass
    return h.hexdigest()[:10]


BUILD = _build_stamp()
# 可用环境变量覆盖数据库路径，便于起独立实例或重置
DB_PATH = Path(os.environ.get("LLMBENCH_DB") or (ROOT / "data" / "bench.db"))
WEB_DIR = ROOT / "web"

store: Store
engine: Engine
sched: SchedulerManager
bench_mod: "BenchManager"
cache_mod: "CacheCheckManager"


@asynccontextmanager
async def lifespan(app: FastAPI):
    global store, engine, sched, bench_mod, cache_mod
    store = Store(DB_PATH)
    await store.init()
    stale = await store.mark_stale_runs()
    if stale:
        logging.getLogger("llmbench").warning("清理 %d 条上次进程遗留的运行状态", stale)
    engine = Engine(store)
    bench_mod = BenchManager(store)
    cache_mod = CacheCheckManager(store)
    sched = SchedulerManager(engine, store)
    sched.start()
    sched.load_all(await store.list_schedules())
    try:
        yield
    finally:
        sched.shutdown()
        await engine.shutdown()
        await bench_mod.shutdown()
        await cache_mod.shutdown()
        await store.close()


app = FastAPI(title="Precision Bench", lifespan=lifespan)


class PasteBody(BaseModel):
    text: str


class ScheduleCreate(BaseModel):
    name: str
    cron: str
    enabled: bool = True
    run: RunConfig
    alert: dict = {}


@app.get("/", response_class=HTMLResponse)
async def index():
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    return html.replace("__BUILD__", BUILD)


@app.get("/bench")
async def bench_page():
    # 降智检测已并入主仪表盘（顶部导航切换）
    from fastapi.responses import RedirectResponse

    return RedirectResponse("/")


@app.post("/api/parse")
async def api_parse(body: PasteBody):
    targets = parse_paste(body.text)
    return {"targets": [t.model_dump() for t in targets], "count": len(targets)}


@app.post("/api/runs")
async def api_start(cfg: RunConfig):
    if not cfg.targets:
        raise HTTPException(400, "没有可用的供应商配置")
    run_ids = await engine.start_many(cfg)
    return {"run_ids": run_ids, "count": len(run_ids)}


@app.get("/api/runs")
async def api_runs():
    rows = await store.list_runs()
    active = await store.list_active_runs()
    known = {row["run_id"] for row in rows}
    rows.extend(row for row in active if row["run_id"] not in known)
    out = []
    for r in rows:
        st = engine.get(r["run_id"])
        item = {
            "run_id": r["run_id"],
            "name": r["name"],
            "provider": r["provider"],
            "model": r["model"],
            "status": r["status"],
            "started_at": r["started_at"],
            "ended_at": r["ended_at"],
            "total": r.get("total", 0),
            "ok": r.get("ok", 0),
            "base_url": r["base_url_masked"],
        }
        if st:
            item["status"] = st.status.value
            item["live"] = True
        out.append(item)
    return {"runs": out}


@app.get("/api/runs/{run_id}")
async def api_run(run_id: str):
    row = await store.get_run(run_id)
    if not row:
        raise HTTPException(404, "run 不存在")
    st = engine.get(run_id)
    stored_summary = row.get("summary_json")
    if st and st.status not in (
        RunStatus.done,
        RunStatus.error,
        RunStatus.stopped,
    ):
        summary = engine.live_summary(st)
        status = st.status.value
    elif stored_summary:
        summary = json.loads(stored_summary)
        status = row["status"]
    else:
        rows = await store.get_samples(run_id, max_points=10000)
        cfg_slo = _slo_from_row(row)
        pin, pout, pcache = _price_from_row(row)
        summary = summarize(
            [_row_to_sample(r) for r in rows],
            cfg_slo,
            pin,
            pout,
            pcache,
            wall_s=_wall_from_row(row),
        )
        status = row["status"]
    return {
        "run": _scrub_row(row),
        "status": status,
        "summary": summary,
        "target": _scrub_target(row),
    }


@app.post("/api/runs/{run_id}/stop")
async def api_stop(run_id: str):
    return {"ok": engine.stop(run_id)}


@app.post("/api/runs/{run_id}/pause")
async def api_pause(run_id: str):
    return {"ok": engine.pause(run_id)}


@app.post("/api/runs/{run_id}/resume")
async def api_resume(run_id: str):
    return {"ok": engine.resume(run_id)}


@app.delete("/api/runs/{run_id}")
async def api_delete(run_id: str):
    if not await store.get_run(run_id):
        raise HTTPException(404, "run 不存在")
    if not await engine.stop_and_wait(run_id):
        raise HTTPException(409, "运行仍有在途请求，请稍后重试删除")
    engine.forget(run_id)
    await store.delete_run(run_id)
    return {"ok": True}


@app.get("/api/runs/{run_id}/samples")
async def api_samples(
    run_id: str,
    since: float | None = None,
    until: float | None = None,
    max_points: int = 4000,
):
    max_points = max(1, min(max_points, 20000))
    await store.flush()
    st = engine.get(run_id)
    cursor = st.event_seq if st else 0
    rows = await store.get_samples(run_id, since, until, max_points=max_points)
    if st:
        by_seq = {r.get("seq"): r for r in rows}
        for sample in st.samples:
            by_seq.setdefault(sample.seq, _sample_to_dict(sample))
        rows = sorted(by_seq.values(), key=lambda r: r.get("seq", 0))
    if not rows and st:
        rows = [_sample_to_dict(s) for s in st.samples]
    if len(rows) > max_points:
        selected = (
            [round(i * (len(rows) - 1) / (max_points - 1)) for i in range(max_points)]
            if max_points > 1
            else [0]
        )
        rows = [rows[i] for i in selected]
    return {"samples": rows, "count": len(rows), "event_seq": cursor}


@app.get("/api/runs/{run_id}/series")
async def api_series(run_id: str, max_points: int = 1500):
    max_points = max(1, min(max_points, 20000))
    rows = await store.get_samples(run_id, max_points=max_points * 4)
    if not rows:
        st = engine.get(run_id)
        if not st:
            raise HTTPException(404, "无数据")
        rows = [_sample_to_dict(s) for s in st.samples]
    if not rows:
        return {
            "ts": [],
            "ttft": [],
            "e2e": [],
            "corrected": [],
            "tpot": [],
            "out_tokens": [],
            "ok": [],
        }
    ts = [r["ts"] for r in rows]
    x = [float(i) for i in range(len(ts))]
    data = {
        "ts": ts,
        "ttft": [r.get("ttft_ms") for r in rows],
        "e2e": [r.get("e2e_ms") for r in rows],
        "corrected": [r.get("corrected_e2e_ms") for r in rows],
        "tpot": [r.get("tpot_ms") for r in rows],
        "out_tokens": [r.get("out_tokens") for r in rows],
        "ok": [1 if r.get("ok") else 0 for r in rows],
    }
    if len(ts) > max_points:
        source = data["e2e"]
        if not any(v is not None for v in source):
            source = data["ttft"]
        selected_x, _ = lttb(x, [v if v is not None else 0 for v in source], max_points)
        selected = [int(i) for i in selected_x]
        data = {
            "ts": [ts[i] for i in selected],
            "ttft": [data["ttft"][i] for i in selected],
            "e2e": [data["e2e"][i] for i in selected],
            "corrected": [data["corrected"][i] for i in selected],
            "tpot": [data["tpot"][i] for i in selected],
            "out_tokens": [data["out_tokens"][i] for i in selected],
            "ok": [data["ok"][i] for i in selected],
        }
    return data


@app.get("/api/runs/{run_id}/stream")
async def api_stream(run_id: str, request: Request):
    st = engine.get(run_id)
    if not st:

        async def empty():
            yield f"data: {json.dumps({'type': 'status', 'status': 'done'})}\n\n"

        return StreamingResponse(empty(), media_type="text/event-stream")

    try:
        after_id = int(request.headers.get("last-event-id", "0"))
    except ValueError:
        after_id = 0
    reset_ack = request.query_params.get("reset") == "1"
    try:
        replay_after = (
            int(request.query_params.get("after_id", "0")) if reset_ack else after_id
        )
    except ValueError:
        replay_after = st.event_seq if reset_ack else after_id

    def encode(event: dict) -> str:
        event_id = event.get("id")
        prefix = f"id: {event_id}\n" if event_id is not None else ""
        return f"{prefix}data: {json.dumps(event, ensure_ascii=False)}\n\n"

    async def gen():
        q = engine.subscribe(run_id)
        try:
            yield encode({"type": "status", "status": st.status.value})
            if not reset_ack and st.events and after_id < st.events[0].get("id", 0) - 1:
                yield encode({"type": "reset"})
            for event in engine.replay_since(run_id, replay_after):
                yield encode(event)
            if st.last_phase:
                yield encode(st.last_phase)
            if st.samples:
                yield encode(
                    {"type": "summary", "live": True, "data": engine.live_summary(st)}
                )
            if st.status in (RunStatus.done, RunStatus.error, RunStatus.stopped):
                return
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    if st.status in (
                        RunStatus.done,
                        RunStatus.error,
                        RunStatus.stopped,
                    ):
                        break
                    continue
                yield encode(event)
                if event.get("type") == "status" and event.get("status") in (
                    "done",
                    "error",
                    "stopped",
                ):
                    break
        finally:
            engine.unsubscribe(run_id, q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/runs/{run_id}/export.csv")
async def api_export_csv(run_id: str):
    rows = await store.get_samples(run_id)
    buf = io.StringIO()
    if rows:
        w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={run_id}.csv"},
    )


@app.get("/api/runs/{run_id}/export.json")
async def api_export_json(run_id: str):
    row = await store.get_run(run_id)
    rows = await store.get_samples(run_id)
    if row and row.get("summary_json"):
        summary = json.loads(row["summary_json"])
    else:
        pin, pout, pcache = _price_from_row(row or {})
        summary = summarize(
            [_row_to_sample(r) for r in rows],
            _slo_from_row(row or {}),
            pin,
            pout,
            pcache,
            wall_s=_wall_from_row(row or {}),
        )
    return JSONResponse({"run": _scrub_row(row), "summary": summary, "samples": rows})


@app.get("/api/schedules")
async def api_schedules():
    # DB 里 config_json 必须保留 api_key 供调度器加载，仅出口脱敏
    return {"schedules": [_scrub_row(s) for s in await store.list_schedules()]}


@app.post("/api/schedules")
async def api_schedule_create(body: ScheduleCreate):
    from .schemas import AlertConfig

    sc = ScheduleConfig(
        name=body.name,
        cron=body.cron,
        enabled=body.enabled,
        run=body.run,
        alert=AlertConfig(**body.alert),
    )
    try:
        sched.validate(sc.cron)  # 先校验，避免无效任务被写进库
        sid = await store.save_schedule(sc)
        sc.schedule_id = sid
        if body.enabled:
            sched.register(sc, sid)
        else:
            sched.remove(sid)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"schedule_id": sid}


@app.delete("/api/schedules/{sid}")
async def api_schedule_delete(sid: str):
    sched.remove(sid)
    await store.delete_schedule(sid)
    return {"ok": True}


@app.get("/api/alerts")
async def api_alerts():
    return {"alerts": await store.list_alerts()}


@app.get("/api/health")
async def api_health():
    return {"ok": True, "ts": time.time(), "build": BUILD}


# ---------------- 探活 / 测速（单次，带分段耗时） ----------------
class ProbeBody(BaseModel):
    targets: list[TargetModel]
    traffic: TrafficConfig = TrafficConfig()
    stream: bool = True
    timeout_s: float = 60.0
    proxy: str | None = None
    verify_tls: bool = True


@app.post("/api/probe")
async def api_probe(body: ProbeBody):
    from . import providers

    cfg = RunConfig(
        targets=[],
        stream=body.stream,
        timeout_s=body.timeout_s,
        proxy=body.proxy,
        verify_tls=body.verify_tls,
        traffic=body.traffic,
    )
    limits = httpx.Limits(max_connections=8, max_keepalive_connections=0)

    async def one(client: httpx.AsyncClient, t) -> dict:
        try:
            res = await providers.probe(client, t, cfg)
            return {
                "name": t.name,
                "provider": t.provider.value,
                "model": t.model,
                "base_url": t.base_url,
                "ok": res.ok,
                "status_code": res.status_code,
                "ttft_ms": _rd(res.ttft_ms),
                "e2e_ms": _rd(res.e2e_ms),
                "tpot_ms": _rd(res.tpot_ms),
                "out_tokens": res.out_tokens,
                "in_tokens": res.in_tokens,
                "dns_ms": _rd(res.dns_ms),
                "tcp_ms": _rd(res.tcp_ms),
                "tls_ms": _rd(res.tls_ms),
                "error_class": res.error_class,
                "error_msg": res.error_msg,
            }
        except Exception as exc:  # noqa: BLE001
            return {
                "name": t.name,
                "provider": t.provider.value,
                "model": t.model,
                "base_url": t.base_url,
                "ok": False,
                "error_class": "client_error",
                "error_msg": str(exc)[:300],
            }

    from .providers import is_loopback

    trust = not any(is_loopback(t.base_url) for t in body.targets)
    async with httpx.AsyncClient(
        timeout=body.timeout_s,
        limits=limits,
        proxy=body.proxy or None,
        verify=body.verify_tls,
        trust_env=trust and not body.proxy,
    ) as client:
        results = await asyncio.gather(*[one(client, t) for t in body.targets])
    return {"results": results}


class ModelsBody(BaseModel):
    targets: list[TargetModel]
    timeout_s: float = 20.0
    proxy: str | None = None
    verify_tls: bool = True


@app.post("/api/targets/models")
async def api_models(body: ModelsBody):
    from .providers import is_loopback

    trust = not any(is_loopback(t.base_url) for t in body.targets)
    async with httpx.AsyncClient(
        timeout=body.timeout_s,
        proxy=body.proxy or None,
        verify=body.verify_tls,
        trust_env=trust and not body.proxy,
    ) as client:
        out = {}
        for t in body.targets:
            out[t.name] = await _list_models(client, t)
    return {"models": out}


async def _list_models(client: httpx.AsyncClient, t) -> list[str]:
    """拉 /v1/models。空 key 不发 Authorization（`Bearer ` 是非法头，httpx 会抛）。"""
    from . import providers

    url = providers._endpoint(t, "/v1/models")  # noqa: SLF001
    headers: dict[str, str] = {}
    if t.api_key:
        if t.provider.value == "anthropic":
            headers = {"x-api-key": t.api_key, "anthropic-version": "2023-06-01"}
        else:
            headers = {"Authorization": f"Bearer {t.api_key}"}
        if t.provider.value == "openrouter":
            headers.setdefault("HTTP-Referer", "http://127.0.0.1:8787")
            headers.setdefault("X-Title", "llm-bench")
    try:
        resp = await client.get(url, headers=headers)
        if resp.status_code >= 400:
            logging.getLogger("llmbench").warning(
                "models list failed url=%s status=%s body=%s",
                url,
                resp.status_code,
                resp.text[:200],
            )
            return []
        data = resp.json()
        items = data.get("data") or data.get("models") or []
        return sorted({str(m.get("id") or m.get("name") or m) for m in items})
    except Exception as exc:
        logging.getLogger("llmbench").warning("models list error url=%s: %s", url, exc)
        return []


# ---------------- 对比 + Markdown 报告 ----------------
@app.get("/api/compare")
async def api_compare(ids: str):
    out = []
    for rid in [x for x in ids.split(",") if x]:
        row = await store.get_run(rid)
        if not row:
            continue
        rows = await store.get_samples(rid)
        if row.get("summary_json"):
            summary = json.loads(row["summary_json"])
        else:
            pin, pout, pcache = _price_from_row(row)
            summary = summarize(
                [_row_to_sample(r) for r in rows],
                _slo_from_row(row),
                pin,
                pout,
                pcache,
                wall_s=_wall_from_row(row),
            )
        out.append(
            {
                "run_id": rid,
                "name": row["name"],
                "model": row["model"],
                "provider": row["provider"],
                "summary": summary,
            }
        )
    return {"runs": out}


@app.get("/api/runs/{run_id}/export.md")
async def api_export_md(run_id: str):
    row = await store.get_run(run_id)
    if not row:
        raise HTTPException(404, "run 不存在")
    rows = await store.get_samples(run_id)
    if row.get("summary_json"):
        s = json.loads(row["summary_json"])
    else:
        pin, pout, pcache = _price_from_row(row)
        s = summarize(
            [_row_to_sample(r) for r in rows],
            _slo_from_row(row),
            pin,
            pout,
            pcache,
            wall_s=_wall_from_row(row),
        )
    tgt = _scrub_target(row) or {}
    md = _to_markdown(row, tgt, s)
    return StreamingResponse(
        iter([md]),
        media_type="text/markdown",
        headers={"Content-Disposition": f"attachment; filename={run_id}.md"},
    )


def _to_markdown(row: dict, tgt: dict, s: dict) -> str:
    e, tt, tp = s["e2e"], s["ttft"], s["tpot"]
    lines = [
        f"# Precision Bench 性能报告 · {row.get('model') or '-'}",
        "",
        f"- **供应商**：{tgt.get('name', '-')}  ({row.get('provider', '-')})",
        f"- **Base URL**：{row.get('base_url_masked', '-')}",
        f"- **模型**：{row.get('model', '-')}",
        f"- **请求数**：{s['total']}（成功 {s['ok']} / 失败 {s['failed']}）",
        f"- **成功率**：{s['success_rate']:.2%}　**Goodput**：{s['goodput']:.2%}（{s.get('request_goodput')} req/s）",
        f"- **RPS**：成功 {s['rps']} / 尝试 {s.get('attempted_rps')}　**墙钟**：{s['wall_s']}s",
        "",
        "| 指标 | mean | P50 | P90 | P95 | P99 |",
        "|---|---|---|---|---|---|",
        f"| E2E (ms) | {e['mean']} | {e['p50']} | {e['p90']} | {e['p95']} | {e['p99']} |",
        f"| TTFT (ms) | {tt['mean']} | {tt['p50']} | {tt['p90']} | {tt['p95']} | {tt['p99']} |",
        f"| TPOT (ms) | {tp['mean']} | {tp['p50']} | {tp['p90']} | {tp['p95']} | {tp['p99']} |",
        "",
        f"- **Output throughput**：{s['tokens'].get('output_throughput')} tok/s（墙钟） / {s['tokens'].get('output_throughput_per_user')} tok/s（解码）",
        f"- **缓存命中**：{(f'{s.get("cache", {}).get("hit_rate", 0):.1%}' if s.get('cache', {}).get('reported', True) else '未上报')}（命中 {s.get('cache', {}).get('cached_tokens', 0)} / 输入 {s['tokens']['in']} tokens，命中请求 {s.get('cache', {}).get('requests_hit', 0)} / 未命中 {s.get('cache', {}).get('requests_miss', 0)}）",
        f"- **TTFT 命中 vs 未命中**：{s.get('cache', {}).get('ttft_hit', {}).get('mean', 0)} ms vs {s.get('cache', {}).get('ttft_miss', {}).get('mean', 0)} ms（加速 {s.get('cache', {}).get('ttft_speedup') or '—'}×）",
        f"- **Token 用量**：输入 {s['tokens']['in']} / 输出 {s['tokens']['out']}",
        f"- **成本估算**：¥{s['cost']['total']}（¥{s['cost']['per_req']}/请求；输入 ¥{s['cost']['price_in']}/M、缓存读 ¥{s['cost'].get('price_cache_in')}/M、缓存写 ¥{s['cost'].get('price_cache_write')}/M、输出 ¥{s['cost']['price_out']}/M）",
        f"- **SLO**：TTFT≤{s['slo']['ttft_ms']}ms ∧ TPOT≤{s['slo']['tpot_ms']}ms，达标 {s['slo']['passed']}/{s['slo']['total']}",
        "",
        "## 错误分布",
        "",
    ]
    if s["errors"]:
        lines += ["| 类别 | 次数 |", "|---|---|"] + [
            f"| {k} | {v} |" for k, v in s["errors"].items()
        ]
    else:
        lines.append("无")
    lines += ["", f"> 生成时间：{time.strftime('%Y-%m-%d %H:%M:%S')}", ""]
    return "\n".join(lines)


# ---------------- 降智检测 ----------------
class BenchBody(BaseModel):
    targets: list[TargetModel]
    engine: str = "curated"  # curated | lm_eval
    dims: list[str] = []
    needle_tokens: int = 4000
    temperature: float = 0.0
    max_tokens: int = 512
    timeout_s: float = 120.0
    proxy: str | None = None
    verify_tls: bool = True
    # 官方数据集参数
    limit: int = 200  # 注意：对组任务（MMLU）是"每个子任务"生效
    fewshot: int | None = None  # None = 用任务默认
    seed: int = 42
    num_concurrent: int = 8
    # 判定统计参数
    alpha: float = 0.05  # 显著性水平
    threshold: float = 0.10  # 兼容旧字段
    min_delta: float = 0.03  # 最小效应量
    name: str = ""


@app.get("/api/bench/datasets")
async def api_bench_datasets():
    from . import lm_eval_runner as L

    return {
        "dimensions": bench_data.list_datasets(),
        "lm_eval": {
            "available": L.available(),
            "version": L.version() if L.available() else None,
            "default_tasks": L.DEFAULT_TASKS,
            "tasks": L.list_tasks(),
        },
    }


class PredownloadBody(BaseModel):
    tasks: list[str] = []


@app.post("/api/bench/predownload")
async def api_bench_predownload(body: PredownloadBody):
    """预下载官方数据集（国内走 hf-mirror），避免跑评测时卡在下载。"""
    from . import lm_eval_runner as L

    tasks = [t for t in (body.tasks or L.DEFAULT_TASKS) if t in L.TASKS]
    if not tasks:
        raise HTTPException(400, "没有可用的官方任务")
    script = (
        "import os; os.environ.setdefault('HF_ENDPOINT', os.environ.get('BENCH_HF', 'https://hf-mirror.com'))\n"
        "from datasets import load_dataset\n"
        f"pairs = {L.dataset_specs(tasks)!r}\n"
        "for path, name in pairs:\n"
        "    load_dataset(path, name, split='test[:1]')\n"
        "    print('ok', path, name)\n"
    )
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        script,
        cwd=str(ROOT),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        async with asyncio.timeout(300):
            out, _ = await proc.communicate()
    except asyncio.CancelledError:
        proc.kill()
        await proc.wait()
        raise
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return {"ok": False, "tasks": tasks, "output": "数据集预下载超时（300 秒）"}
    return {
        "ok": proc.returncode == 0,
        "tasks": tasks,
        "output": out.decode("utf-8", "replace")[-1500:],
    }


@app.post("/api/bench/run")
async def api_bench_run(body: BenchBody):
    if not body.targets:
        raise HTTPException(400, "没有可用的供应商配置")
    opts = body.model_dump(exclude={"targets"})
    ids = await bench_mod.start(body.targets, opts)
    return {"run_ids": ids, "count": len(ids)}


@app.get("/api/bench/runs")
async def api_bench_runs():
    rows = await store.list_bench_runs()
    for r in rows:
        st = bench_mod.get(r["run_id"])
        if st:
            r["status"] = st.status
            r["live"] = True
    return {"runs": rows}


@app.get("/api/bench/runs/{rid}")
async def api_bench_run_detail(rid: str):
    row = await store.get_bench_run(rid)
    if not row:
        raise HTTPException(404, "bench run 不存在")
    st = bench_mod.get(rid)
    event_seq = st.event_seq if st else 0
    if st and st.status in ("running", "pending", "stopping"):
        items = st.results
        row["scores"] = st.scores or row.get("scores", {})
    else:
        items = await store.get_bench_items(rid)
    return {"run": row, "items": items, "event_seq": event_seq}


@app.get("/api/bench/runs/{rid}/stream")
async def api_bench_stream(rid: str, request: Request):
    st = bench_mod.get(rid)
    if not st:

        async def empty():
            yield f"data: {json.dumps({'type': 'status', 'status': 'done'})}\n\n"

        return StreamingResponse(empty(), media_type="text/event-stream")

    try:
        after_id = int(request.headers.get("last-event-id", "0"))
    except ValueError:
        after_id = 0
    reset_ack = request.query_params.get("reset") == "1"
    try:
        replay_after = (
            int(request.query_params.get("after_id", "0")) if reset_ack else after_id
        )
    except ValueError:
        replay_after = st.event_seq if reset_ack else after_id

    def encode(event: dict) -> str:
        event_id = event.get("id")
        prefix = f"id: {event_id}\n" if event_id is not None else ""
        return f"{prefix}data: {json.dumps(event, ensure_ascii=False)}\n\n"

    async def gen():
        q = bench_mod.subscribe(rid)
        try:
            yield encode({"type": "status", "status": st.status})
            if not reset_ack and st.events and after_id < st.events[0].get("id", 0) - 1:
                yield encode({"type": "reset"})
            for event in bench_mod.replay_since(rid, replay_after):
                yield encode(event)
            if st.status in ("done", "error", "stopped"):
                return
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    if st.status in ("done", "error", "stopped"):
                        break
                    continue
                yield encode(ev)
                if ev.get("type") == "status" and ev.get("status") in (
                    "done",
                    "error",
                    "stopped",
                ):
                    break
        finally:
            bench_mod.unsubscribe(rid, q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/bench/runs/{rid}/stop")
async def api_bench_stop(rid: str):
    return {"ok": bench_mod.stop(rid)}


@app.post("/api/bench/runs/{rid}/baseline")
async def api_bench_baseline(rid: str):
    row = await store.get_bench_run(rid)
    if not row:
        raise HTTPException(404, "bench run 不存在")
    if row.get("status") != "done":
        raise HTTPException(409, "只有已完成的检测才能设为基线")
    if row.get("n_items") and row.get("completed", 0) < row.get("n_items", 0):
        raise HTTPException(409, "检测尚未完成全部题目")
    # 基线按题集隔离：优先用运行记录里的 task_key，老数据回落到维度推导
    task_key = row.get("task_key")
    if not task_key:
        opts = row.get("opts") or json.loads(row.get("opts_json") or "{}")
        engine = row.get("engine") or opts.get("engine") or "curated"
        dims = sorted(json.loads(row.get("dims_json") or "[]"))
        lm_eval_version = row.get("lm_eval_version") or opts.get("lm_eval_version")
        parts = [f"{engine}:" + ",".join(dims)]
        if engine == "lm_eval":
            parts.append(f"provider={row.get('provider')}")
        for key in (
            "limit",
            "fewshot",
            "seed",
            "max_tokens",
            "temperature",
            "needle_tokens",
        ):
            if key in opts:
                parts.append(f"{key}={opts.get(key)}")
        if engine == "lm_eval" and lm_eval_version:
            parts.append(f"lm_eval_version={lm_eval_version}")
        task_key = "|".join(parts)
    await store.set_baseline(
        row["base_url_masked"],
        row["model"],
        task_key,
        rid,
        row.get("total_score") or 0.0,
        row.get("fingerprint") or "",
    )
    return {"ok": True}


@app.delete("/api/bench/runs/{rid}")
async def api_bench_delete(rid: str):
    if not await store.get_bench_run(rid):
        raise HTTPException(404, "bench run 不存在")
    if not await bench_mod.stop_and_wait(rid):
        raise HTTPException(409, "检测仍有在途任务，请稍后重试删除")
    bench_mod.forget(rid)
    await store.delete_bench_run(rid)
    return {"ok": True}


@app.get("/api/bench/baselines")
async def api_bench_baselines():
    return {"baselines": await store.list_baselines()}


# ---------------- 缓存检测（主动验证 Prompt Cache） ----------------
class CacheCheckBody(BaseModel):
    targets: list[TargetModel]
    rounds: int = 6
    prefix_tokens: int = 2048
    speedup_threshold: float = 1.5
    max_tokens: int = 512
    stream: bool = True
    timeout_s: float = 60.0
    proxy: str | None = None
    verify_tls: bool = True
    background: bool = False


async def _decorate_cache_results(results: list[dict]) -> list[dict]:
    decorated = []
    for raw in results:
        r = dict(raw)
        r["base_url_masked"] = _mask(r.pop("base_url", ""))
        base = await store.get_cache_baseline(r["base_url_masked"], r["model"])
        r["baseline"] = (
            {"check_id": base["check_id"], "speedup": base.get("speedup")}
            if base
            else None
        )
        decorated.append(r)
    return decorated


@app.post("/api/cache/check")
async def api_cache_check(body: CacheCheckBody):
    if not body.targets:
        raise HTTPException(400, "没有可检测的渠道，请先粘贴并识别配置")
    p = CacheCheckParams(
        rounds=body.rounds,
        prefix_tokens=body.prefix_tokens,
        speedup_threshold=body.speedup_threshold,
        max_tokens=body.max_tokens,
        stream=body.stream,
        timeout_s=body.timeout_s,
        proxy=body.proxy,
        verify_tls=body.verify_tls,
    )
    if body.background:
        return {"job_id": await cache_mod.start(body.targets, p), "status": "running"}
    results = await cache_mod.run(body.targets, p)
    return {"results": await _decorate_cache_results(results)}


@app.get("/api/cache/check/{job_id}")
async def api_cache_check_job(job_id: str):
    job = cache_mod.get_job(job_id)
    if not job:
        raise HTTPException(404, "缓存检测任务不存在")
    if job.get("results") is not None:
        job["results"] = await _decorate_cache_results(job["results"])
    return job


@app.post("/api/cache/check/{job_id}/cancel")
async def api_cache_check_cancel(job_id: str):
    return {"ok": cache_mod.cancel(job_id), "job_id": job_id}


@app.get("/api/cache/checks")
async def api_cache_checks(limit: int = 20, offset: int = 0):
    limit = min(max(int(limit), 1), 100)
    offset = max(int(offset), 0)
    rows = await store.list_cache_checks(limit=limit + 1, offset=offset)
    has_more = len(rows) > limit
    checks = rows[:limit]
    for c in checks:
        base = await store.get_cache_baseline(c["base_url_masked"], c["model"])
        c["is_baseline"] = bool(base and base.get("check_id") == c["id"])
    return {
        "checks": checks,
        "has_more": has_more,
        "next_offset": offset + len(checks),
    }


@app.get("/api/cache/checks/{cid}")
async def api_cache_check_detail(cid: str):
    d = await store.get_cache_check(cid)
    if not d:
        raise HTTPException(404, "检测记录不存在")
    base = await store.get_cache_baseline(d["base_url_masked"], d["model"])
    d["is_baseline"] = bool(base and base.get("check_id") == cid)
    d["baseline"] = base
    return d


@app.post("/api/cache/checks/{cid}/baseline")
async def api_cache_check_baseline(cid: str):
    d = await store.get_cache_check(cid)
    if not d:
        raise HTTPException(404, "检测记录不存在")
    await store.set_cache_baseline(
        d["base_url_masked"],
        d["model"],
        cid,
        (d.get("summary") or {}).get("speedup_min")
        if (d.get("summary") or {}).get("speedup_min") is not None
        else (d.get("summary") or {}).get("speedup"),
    )
    return {"ok": True}


@app.delete("/api/cache/checks/{cid}")
async def api_cache_check_delete(cid: str):
    await store.delete_cache_check(cid)
    return {"ok": True}


app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


def _slo_from_row(row: dict) -> SLO:
    try:
        return SLO(**json.loads(row.get("slo_json") or "{}"))
    except Exception:
        return SLO()


def _scrub_secrets(obj):
    """递归剔除 api_key（防历史数据/异常嵌套再出口泄露）。"""
    if isinstance(obj, dict):
        return {k: _scrub_secrets(v) for k, v in obj.items() if k != "api_key"}
    if isinstance(obj, list):
        return [_scrub_secrets(x) for x in obj]
    return obj


def _scrub_json_str(s: str | None) -> str | None:
    if not s:
        return s
    try:
        return json.dumps(_scrub_secrets(json.loads(s)), ensure_ascii=False)
    except Exception:
        return s


def _scrub_row(row: dict | None) -> dict | None:
    if not row:
        return row
    out = dict(row)
    if "params_json" in out:
        out["params_json"] = _scrub_json_str(out.get("params_json"))
    if "config_json" in out:
        out["config_json"] = _scrub_json_str(out.get("config_json"))
    return out


def _scrub_target(row: dict | None) -> dict | None:
    if not row or not row.get("params_json"):
        return None
    try:
        tgt = json.loads(row["params_json"])["targets"][0]
    except Exception:
        return None
    if not isinstance(tgt, dict):
        return None
    scrubbed = _scrub_secrets(tgt)
    return scrubbed if isinstance(scrubbed, dict) else None


def _wall_from_row(row: dict) -> float | None:
    try:
        started = float(row.get("started_at") or 0)
        ended = float(row.get("ended_at") or 0)
        return ended - started if started > 0 and ended >= started else None
    except (TypeError, ValueError):
        return None


def _price_from_row(row: dict) -> tuple[float, float, float]:
    try:
        cfg = json.loads(row.get("params_json") or "{}")
        return (
            float(cfg.get("price_in") or 0.0),
            float(cfg.get("price_out") or 0.0),
            float(cfg.get("price_cache_in") or 0.0),
        )
    except Exception:
        return 0.0, 0.0, 0.0


def _rd(v: float | None) -> float | None:
    return None if v is None else round(float(v), 2)


def _sample_to_dict(s) -> dict:
    return s.model_dump()
