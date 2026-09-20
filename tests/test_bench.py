"""降智检测：判分单测 + 运行器端到端（用 MockTransport 伪造正确/降智上游）。"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from server import bench_data
from server.bench import BenchManager
from server.parse import parse_paste
from server.store import Store


def test_grade_basic():
    cases = [
        ({"type": "numeric", "answer": 6}, "答案是 6", True),
        ({"type": "numeric", "answer": 6}, "7", False),
        ({"type": "mcq", "answer": "B"}, "The answer is B", True),
        ({"type": "mcq", "answer": "B"}, "C", False),
        (
            {"type": "json", "checks": {"name": "bench", "score": 100}},
            '{"name":"bench","score":100}',
            True,
        ),
        (
            {"type": "json", "checks": {"name": "bench", "score": 100}},
            '```json\n{"name":"bench","score":99}\n```',
            False,
        ),
        ({"type": "word_count", "value": 3}, "a b c", True),
        ({"type": "word_count", "value": 3}, "a b", False),
        ({"type": "exact_nospace", "answer": "[3,2,1]"}, "[3, 2, 1]", True),
        ({"type": "startswith", "value": "首先"}, "首先做 A", True),
        ({"type": "endswith", "value": "完毕。"}, "这是介绍。完毕。", True),
        ({"type": "contains", "all": ["paris", "巴黎"], "mode": "any"}, "Paris", True),
    ]
    for spec, text, want in cases:
        got, _ = bench_data.grade(spec, text)
        assert got is want, (spec, text, got, want)


def test_dataset_counts():
    ds = {d["dim"]: d for d in bench_data.list_datasets()}
    assert ds["math"]["count"] >= 10
    assert ds["knowledge"]["count"] >= 10
    assert ds["needle"]["dynamic"] is True


def _answer_for(question: str) -> str:
    """按题面查表，返回一个'正确'答案（模拟未降智模型）。"""
    q = question.strip()
    for it in bench_data.ITEMS:
        if it["q"].strip() == q:
            g = it["g"]
            t = g["type"]
            if t == "numeric":
                return str(g["answer"])
            if t == "mcq":
                return g["answer"]
            if t in ("exact_ci", "exact_nospace"):
                return g["answer"]
    return "?"


def _mock_client() -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        q = body["messages"][-1]["content"]
        ans = _answer_for(q)
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"role": "assistant", "content": ans}}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 3},
            },
        )

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def _wait(engine: BenchManager, rid: str, timeout: float = 30.0) -> None:
    loop = asyncio.get_event_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        st = engine.get(rid)
        if st and st.status in ("done", "error", "stopped"):
            return
        await asyncio.sleep(0.1)
    raise TimeoutError("bench run 未结束")


@pytest.mark.asyncio
async def test_bench_runner(tmp_path, monkeypatch):
    store = Store(tmp_path / "b.db")
    await store.init()
    mgr = BenchManager(store)
    monkeypatch.setattr(BenchManager, "_client", lambda self, opts: _mock_client())

    target = parse_paste("base_url: http://mock.local\napi_key: sk-x\nmodel: gpt-4o")[0]
    ids = await mgr.start(
        [target], {"dims": ["math", "knowledge", "code"], "threshold": 0.1, "name": "t"}
    )
    rid = ids[0]
    await _wait(mgr, rid)
    run = await store.get_bench_run(rid)
    assert run["status"] == "done"
    s = run["scores"]
    # 全对 → 各维度 1.0
    assert s["total"] == 1.0, s
    assert s["dims"]["math"]["score"] == 1.0
    items = await store.get_bench_items(rid)
    assert len(items) == s["completed"] > 0
    # 首次运行应记为基线
    base = await store.get_baseline(
        target.base_url, target.model, "curated:code,knowledge,math"
    )
    assert base and base["bench_run_id"] == rid
    await store.close()


@pytest.mark.asyncio
async def test_bench_degradation_verdict(tmp_path, monkeypatch):
    """第二次运行故意答错一半 → 判定疑似降智。"""
    store = Store(tmp_path / "c.db")
    await store.init()
    mgr = BenchManager(store)

    # 第一次：全对，作为基线
    monkeypatch.setattr(BenchManager, "_client", lambda self, opts: _mock_client())
    target = parse_paste("base_url: http://mock.local\napi_key: sk-x\nmodel: gpt-4o")[0]
    r1 = (await mgr.start([target], {"dims": ["math", "knowledge"], "threshold": 0.1}))[
        0
    ]
    await _wait(mgr, r1)

    # 第二次：全部答错
    def bad_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "I do not know"}}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 3},
            },
        )

    bad = httpx.AsyncClient(transport=httpx.MockTransport(bad_handler))
    monkeypatch.setattr(BenchManager, "_client", lambda self, opts: bad)
    r2 = (await mgr.start([target], {"dims": ["math", "knowledge"], "threshold": 0.1}))[
        0
    ]
    await _wait(mgr, r2)

    run2 = await store.get_bench_run(r2)
    assert run2["scores"]["total"] == 0.0
    comp = run2["scores"]["comparison"]
    assert comp["verdict"] == "suspect", comp
    assert comp["delta"] <= -0.1
    assert comp["fingerprint_changed"] is True
    await store.close()
