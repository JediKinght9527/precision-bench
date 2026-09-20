"""缓存检测：判定四分支 + 端到端（mock 上游 miss→hit）+ 落库与基线。"""

from __future__ import annotations

import pytest

from server.cachecheck import CacheCheckManager, CacheCheckParams, _summarize
from server.parse import parse_paste
from server.schemas import Target
from server.store import Store


def _round(seq, ok=True, ttft=100.0, cached=0, write=0):
    return {
        "seq": seq, "ok": ok, "status_code": 200 if ok else None,
        "ttft_ms": ttft if ok else None, "e2e_ms": (ttft or 0) + 50,
        "cached_tokens": cached, "cache_write_tokens": write,
        "in_tokens": 2048, "out_tokens": 10,
        "error_class": None if ok else "timeout", "error_msg": None,
    }


P = CacheCheckParams(rounds=6, prefix_tokens=2048, speedup_threshold=1.5)


def test_summarize_valid():
    """第 1 轮 miss（写入）、后续全部命中且加速明显 → 缓存有效。"""
    rounds = [_round(1, ttft=300.0, write=2048)] + [
        _round(i, ttft=110.0, cached=2048) for i in range(2, 7)
    ]
    s = _summarize(rounds, P)
    assert s["verdict"] == "valid"
    assert s["speedup"] >= P.speedup_threshold
    assert s["speedup_min"] >= P.speedup_threshold
    assert s["hit_requests"] == 5
    assert s["provider_reported"] is True


def test_summarize_suspect_fake_cache():
    """上游上报命中但 TTFT 没有下降 → 疑似假缓存（假缓存典型形态：首轮真 miss，之后报命中却不见加速）。"""
    rounds = [_round(1, ttft=300.0)] + [
        _round(i, ttft=295.0, cached=2048) for i in range(2, 7)
    ]
    s = _summarize(rounds, P)
    assert s["verdict"] == "suspect"
    assert s["speedup"] is not None and s["speedup"] < P.speedup_threshold


def test_summarize_unreported():
    """成功但没有任何缓存字段 → 未上报（中转吞 usage / 渠道无缓存）。"""
    rounds = [_round(i, ttft=100.0) for i in range(1, 7)]
    s = _summarize(rounds, P)
    assert s["verdict"] == "unreported"
    assert s["provider_reported"] is False


def test_summarize_error():
    rounds = [_round(i, ok=False) for i in range(1, 7)]
    s = _summarize(rounds, P)
    assert s["verdict"] == "error"
    assert any("连通性" in n for n in s["notes"])


def test_summarize_partial_success_note():
    """部分轮次失败 → 附「仅 N/M 轮成功」提示（§10 数据可信度）。"""
    rounds = [_round(1, ttft=300.0, write=2048)] + [
        _round(i, ttft=110.0, cached=2048) for i in range(2, 5)
    ] + [_round(5, ok=False), _round(6, ok=False)]
    s = _summarize(rounds, P)
    assert s["verdict"] == "valid"
    assert any("4/6" in n for n in s["notes"])


@pytest.mark.asyncio
async def test_cache_check_end_to_end(mock_server, tmp_path):
    """端到端：mock 同前缀第 2 轮起命中，判定应为 valid 并落库。"""
    store = await _make_store(tmp_path)
    mgr = CacheCheckManager(store)
    target = parse_paste(f"base_url: {mock_server}\napi_key: k\nmodel: gpt-4o")[0]
    p = CacheCheckParams(rounds=4, prefix_tokens=1024, speedup_threshold=1.5, timeout_s=20)
    out = await mgr.run([target], p)
    assert len(out) == 1
    r = out[0]
    assert r["summary"]["verdict"] == "valid"
    assert len(r["rounds"]) == 4
    assert r["rounds"][0]["cached_tokens"] == 0          # 第 1 轮写入
    assert all(x["cached_tokens"] > 0 for x in r["rounds"][1:])  # 之后命中
    # 落库可查
    checks = await store.list_cache_checks()
    assert len(checks) == 1
    detail = await store.get_cache_check(r["check_id"])
    assert detail["summary"]["verdict"] == "valid"
    assert len(detail["rounds"]) == 4
    await store.close()


@pytest.mark.asyncio
async def test_cache_baseline_flow(mock_server, tmp_path):
    """基线：设置 → 查询 → 删除连带清除。"""
    store = await _make_store(tmp_path)
    mgr = CacheCheckManager(store)
    target = parse_paste(f"base_url: {mock_server}\napi_key: k\nmodel: gpt-4o")[0]
    out = await mgr.run([target], CacheCheckParams(rounds=3, prefix_tokens=512, timeout_s=20))
    cid = out[0]["check_id"]
    await store.set_cache_baseline(
        out[0]["base_url"], out[0]["model"], cid, out[0]["summary"]["speedup"]
    )
    base = await store.get_cache_baseline(out[0]["base_url"], out[0]["model"])
    assert base and base["check_id"] == cid
    assert base["speedup"] == out[0]["summary"]["speedup"]
    await store.delete_cache_check(cid)
    assert await store.get_cache_check(cid) is None
    assert await store.get_cache_baseline(out[0]["base_url"], out[0]["model"]) is None
    await store.close()


async def _make_store(tmp_path) -> Store:
    store = Store(tmp_path / "t.db")
    await store.init()
    return store


def test_summarize_valid_despite_outlier():
    """思考模型场景：命中轮里混一轮长思考（3325ms），中位口径 1.47× 低于阈值，
    但 min 口径 1.9× 达标 → 缓存有效，且 note 说明中位偏低是噪声。"""
    rounds = [_round(1, ttft=3135.0, write=2048)] + [
        _round(2, ttft=1649.0, cached=2048),
        _round(3, ttft=3325.0, cached=2048),
        _round(4, ttft=2134.0, cached=2048),
    ]
    s = _summarize(rounds, P)
    assert s["verdict"] == "valid"
    assert s["speedup_min"] >= P.speedup_threshold
    assert s["speedup"] < P.speedup_threshold
    assert any("噪声" in n for n in s["notes"])
