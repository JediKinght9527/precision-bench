"""打点精度测试：用可控延迟的假上游验证 TTFT / TPOT / token 数。"""

from __future__ import annotations

import httpx
import pytest

from server import providers
from server.parse import parse_paste
from server.schemas import Provider, RunConfig, TrafficConfig
from tests.mock_upstream import N_TOKENS, TOKEN_DELAY, TTFT


def _cfg() -> RunConfig:
    return RunConfig(
        targets=[],
        concurrency=1,
        request_count=1,
        stream=True,
        traffic=TrafficConfig(prompt_mode="tiny", max_tokens=64),
    )


@pytest.mark.asyncio
async def test_openai_stream_instrumentation(mock_server):
    target = parse_paste(f"base_url: {mock_server}\napi_key: sk-x\nmodel: gpt-4o")[0]
    assert target.provider == Provider.openai
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        res = await providers.execute(
            client, target, _cfg(), [{"role": "user", "content": "hi"}], 5
        )
    assert res.ok, res.error_msg
    assert res.ttft_ms is not None and res.tpot_ms is not None
    assert res.status_code == 200
    # TTFT ≈ 100ms
    assert abs(res.ttft_ms - TTFT * 1000) < 60, res.ttft_ms
    # TPOT ≈ 20ms
    assert abs(res.tpot_ms - TOKEN_DELAY * 1000) < 12, res.tpot_ms
    # usage 优先，应为精确 token 数
    assert res.out_tokens == N_TOKENS
    assert res.tokens_estimated is False


@pytest.mark.asyncio
async def test_anthropic_stream_instrumentation(mock_server):
    target = parse_paste(
        f"base_url: {mock_server}\napi_key: sk-ant-x\nmodel: claude-3-5-sonnet"
    )[0]
    assert target.provider == Provider.anthropic
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        res = await providers.execute(
            client, target, _cfg(), [{"role": "user", "content": "hi"}], 5
        )
    assert res.ok, res.error_msg
    assert res.ttft_ms is not None and res.tpot_ms is not None
    assert abs(res.ttft_ms - TTFT * 1000) < 60, res.ttft_ms
    assert abs(res.tpot_ms - TOKEN_DELAY * 1000) < 12, res.tpot_ms
    assert res.out_tokens == N_TOKENS


@pytest.mark.asyncio
async def test_error_classification(mock_server):
    target = parse_paste(f"base_url: {mock_server}\napi_key: sk-x\nmodel: force-error")[
        0
    ]
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        res = await providers.execute(
            client, target, _cfg(), [{"role": "user", "content": "hi"}], 5
        )
    assert res.ok is False
    assert res.status_code == 429
    assert res.error_class == "rate_limit"


@pytest.mark.asyncio
async def test_non_stream_fallback(mock_server):
    cfg = _cfg()
    cfg.stream = False
    target = parse_paste(f"base_url: {mock_server}\napi_key: sk-x\nmodel: gpt-4o")[0]
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        res = await providers.execute(
            client, target, cfg, [{"role": "user", "content": "hi"}], 5
        )
    assert res.ok
    assert res.out_tokens == N_TOKENS
    assert res.ttft_ms == res.e2e_ms
