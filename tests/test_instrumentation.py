"""打点精度测试：用可控延迟的假上游验证 TTFT / TPOT / token 数。"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from server import providers
from server.parse import parse_paste
from server.schemas import Provider, RunConfig, TrafficConfig
from tests.mock_upstream import N_TOKENS, TOKEN_DELAY, TTFT


@pytest.mark.asyncio
async def test_execute_total_timeout_covers_trickle_stream():
    async def handler(_request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.2)
        return httpx.Response(200, text="data: [DONE]\\n\\n")

    target = parse_paste("base_url: http://mock.local\\napi_key: sk-x\\nmodel: gpt-4o")[
        0
    ]
    cfg = RunConfig(
        targets=[],
        concurrency=1,
        request_count=1,
        timeout_s=0.05,
        stream=True,
        traffic=TrafficConfig(prompt_mode="tiny", max_tokens=64),
    )
    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(
        transport=transport, timeout=30, trust_env=False
    ) as client:
        res = await providers.execute(
            client,
            target,
            cfg,
            [{"role": "user", "content": "hi"}],
            5,
            timeout=cfg.timeout_s,
        )
    assert not res.ok
    assert res.e2e_ms is not None and res.e2e_ms < 150


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


def test_headers_empty_key_skips_bearer():
    """空 key 禁止 `Bearer `（httpx Illegal header value）；openrouter 带 Referer。"""
    from server.schemas import Target

    t = Target(
        name="or",
        provider=Provider.openrouter,
        base_url="https://openrouter.ai/api/v1",
        api_key="",
    )
    h = providers._headers(t, Provider.openrouter)
    assert "Authorization" not in h

    t2 = Target(
        name="or2",
        provider=Provider.openrouter,
        base_url="https://openrouter.ai/api/v1",
        api_key="sk-or-v1-x",
    )
    h2 = providers._headers(t2, Provider.openrouter)
    assert h2["Authorization"] == "Bearer sk-or-v1-x"
    assert h2.get("X-Title") == "llm-bench"

    ta = Target(
        name="a",
        provider=Provider.anthropic,
        base_url="https://api.anthropic.com",
        api_key="",
    )
    ha = providers._headers(ta, Provider.anthropic)
    assert "x-api-key" not in ha
    assert "Authorization" not in ha


@pytest.mark.asyncio
async def test_list_models_empty_key_no_header_error():
    """空 key 拉模型：不发 Authorization，httpx 不得抛 Illegal header。"""
    from server.main import _list_models

    target = parse_paste("base_url: https://openrouter.ai/api/v1\nmodel: gpt-4o")[0]
    # 无 key：应走无 Authorization 路径（不抛）；上游可达时 n>=0
    async with httpx.AsyncClient(timeout=20, trust_env=False) as client:
        models = await _list_models(client, target)
    assert isinstance(models, list)  # 至少不因 Bearer 空头炸成异常返回
