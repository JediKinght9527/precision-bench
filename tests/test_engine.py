"""引擎端到端：并发、定频 CO 修正、持久化。"""

from __future__ import annotations

import asyncio
from typing import cast

import pytest

from server.engine import Engine, build_messages
from server.parse import parse_paste
from server.schemas import LoadMode, RunConfig, RunStatus, Target, TrafficConfig
from server.store import Store


async def _wait_done(engine: Engine, run_ids: list[str], timeout: float = 20.0) -> None:
    def is_done(rid: str) -> bool:
        st = engine.get(rid)
        return st is None or st.status.value in ("done", "error")

    loop = asyncio.get_event_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        if all(is_done(r) for r in run_ids):
            return
        await asyncio.sleep(0.1)
    raise TimeoutError("run 未在预期时间内结束")


async def _make_store(tmp_path) -> Store:
    store = Store(tmp_path / "t.db")
    await store.init()
    return store


def test_cache_mode_keeps_prefix_stable():
    cfg = RunConfig(
        randomize=True,
        cache_mode=True,
        traffic=TrafficConfig(
            prompt_mode="custom", prompt="stable-prefix", max_tokens=16
        ),
    )
    first, _ = build_messages(cfg, "gpt-4o")
    second, _ = build_messages(cfg, "gpt-4o")
    assert first == second
    cfg.cache_mode = False
    third, _ = build_messages(cfg, "gpt-4o")
    fourth, _ = build_messages(cfg, "gpt-4o")
    assert third != fourth


@pytest.mark.asyncio
async def test_engine_closed(mock_server, tmp_path):
    store = await _make_store(tmp_path)
    engine = Engine(store)
    target = parse_paste(f"base_url: {mock_server}\napi_key: k\nmodel: gpt-4o")[0]
    cfg = RunConfig(
        targets=[target],
        concurrency=2,
        request_count=6,
        warmup=0,
        stream=True,
        traffic=TrafficConfig(prompt_mode="tiny", max_tokens=64),
    )
    ids = await engine.start_many(cfg)
    await _wait_done(engine, ids)
    rows = await store.get_samples(ids[0])
    assert len(rows) == 6
    assert all(r["ok"] == 1 for r in rows)
    assert all(r["ttft_ms"] and r["ttft_ms"] > 50 for r in rows)
    limited = await store.get_samples(ids[0], max_points=3)
    assert len(limited) <= 3
    await store.close()


@pytest.mark.asyncio
async def test_engine_open_co_correction(mock_server, tmp_path):
    """并发上限=1 + 高定频 → 排队导致 corrected 延迟显著大于 observed。"""
    store = await _make_store(tmp_path)
    engine = Engine(store)
    target = parse_paste(f"base_url: {mock_server}\napi_key: k\nmodel: gpt-4o")[0]
    cfg = RunConfig(
        targets=[target],
        mode=LoadMode.open,
        rate=15,
        duration_s=1.2,
        concurrency=1,
        warmup=0,
        stream=True,
        traffic=TrafficConfig(prompt_mode="tiny", max_tokens=64),
    )
    ids = await engine.start_many(cfg)
    await _wait_done(engine, ids)
    rows = await store.get_samples(ids[0])
    assert len(rows) >= 3
    # 所有样本都记录了 corrected，且被协调遗漏修正后 >= observed
    assert all(r["corrected_e2e_ms"] is not None for r in rows)
    assert all(r["corrected_e2e_ms"] >= r["observed_e2e_ms"] - 1 for r in rows)
    # 存在明显排队：最大 corrected 应远大于单请求耗时（TTFT 100ms + 10*20ms ≈ 280ms）
    assert max(r["corrected_e2e_ms"] for r in rows) > 500
    await store.close()


@pytest.mark.asyncio
async def test_engine_retry_counted(mock_server, tmp_path):
    store = await _make_store(tmp_path)
    engine = Engine(store)
    target = parse_paste(f"base_url: {mock_server}\napi_key: k\nmodel: force-error")[0]
    cfg = RunConfig(
        targets=[target],
        concurrency=1,
        request_count=2,
        warmup=0,
        retries=1,
        stream=True,
        traffic=TrafficConfig(prompt_mode="tiny", max_tokens=64),
    )
    ids = await engine.start_many(cfg)
    await _wait_done(engine, ids)
    rows = await store.get_samples(ids[0])
    assert len(rows) >= 2
    # 重试不掩盖失败：仍有 rate_limit 错误记录
    assert any(r["error_class"] == "rate_limit" for r in rows)
    assert any(r["retry_no"] >= 1 for r in rows)
    await store.close()


def test_event_log_replays_terminal_events():
    from server.engine import Engine, RunState

    engine = Engine(cast(Store, None))
    st = RunState(run_id="replay", cfg=cast(RunConfig, None), target=cast(Target, None))
    engine.runs["replay"] = st
    q = engine.subscribe("replay")
    for seq in range(1100):
        engine._emit(st, {"type": "sample", "data": {"seq": seq}})
    engine._emit(st, {"type": "status", "status": "done"})
    assert q.qsize() == 1000
    assert st.events[-1]["id"] == 1101
    assert engine.replay_since("replay", 1099)[-1]["type"] == "status"
    engine.unsubscribe("replay", q)


def test_stop_enters_stopping_state():
    from server.engine import Engine, RunState

    engine = Engine(cast(Store, None))
    st = RunState(run_id="stop", cfg=cast(RunConfig, None), target=cast(Target, None))
    engine.runs["stop"] = st
    assert engine.stop("stop")
    assert st.status == RunStatus.stopping
    assert not engine.resume("stop")


async def test_finished_runs_are_evicted(tmp_path):
    """已结束的运行不能无限占用内存。"""
    from server.engine import Engine, KEEP_FINISHED, RunState

    store = await _make_store(tmp_path)
    engine = Engine(store)
    total = KEEP_FINISHED + 12
    for i in range(total):
        rid = f"r{i:03d}"
        st = RunState(run_id=rid, cfg=cast(RunConfig, None), target=cast(Target, None))
        st.status = RunStatus.done
        st.ended_at = float(i)
        engine.runs[rid] = st
    engine._evict()
    assert len(engine.runs) == KEEP_FINISHED, len(engine.runs)
    # 保留的应是最新的那批
    assert "r000" not in engine.runs
    assert f"r{total - 1:03d}" in engine.runs
    await store.close()


async def test_forget_removes_state(tmp_path):
    from server.engine import Engine, RunState

    store = await _make_store(tmp_path)
    engine = Engine(store)
    engine.runs["x"] = RunState(
        run_id="x", cfg=cast(RunConfig, None), target=cast(Target, None)
    )
    engine.forget("x")
    assert "x" not in engine.runs
    await store.close()


async def test_stale_runs_marked_stopped(tmp_path):
    """进程重启后，库里残留的 running 必须被标记为 stopped（否则界面有幽灵运行）。"""
    store = await _make_store(tmp_path)
    target = parse_paste(f"base_url: http://127.0.0.1:1\napi_key: sk-x\nmodel: gpt-4o")[
        0
    ]
    cfg = RunConfig(targets=[target], concurrency=1, request_count=1)
    await store.create_run("ghost-run", cfg)
    await store.set_status("ghost-run", RunStatus.running)
    n = await store.mark_stale_runs()
    assert n == 1
    row = await store.get_run("ghost-run")
    assert row is not None
    assert row["status"] == "stopped"
    await store.close()
