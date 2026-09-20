"""测试用假上游：可控 TTFT / 逐 token 延迟 / 错误注入 / 缓存行为模拟。

缓存模拟三态（x-test-cache 头控制，默认真实模拟）：
  （默认）     第 1 次请求写入缓存（miss，TTFT ×1.15），之后命中（TTFT ×0.35），
              上报 cached_tokens ≈ 输入 token 数 —— 用于验证「缓存有效」判定
  nocache     永不返回缓存字段 —— 模拟中转吞 usage / 渠道无缓存（unreported 分支）
  fake        永远上报命中但 TTFT 不降 —— 模拟假缓存（suspect 分支）

POST /__reset 清空缓存记忆（测试隔离用）。
"""

from __future__ import annotations

import asyncio
import hashlib
import json

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI()

# ---- 测试专用：会"答对"的 GSM8K 模型，用于验证非零分数的解析 ----
_GSM: dict[str, str] | None = None


def _gsm_lookup(prompt: str) -> str | None:
    """把 prompt 里的题目与 GSM8K 数据集匹配，返回最终数值答案。"""
    global _GSM
    if _GSM is None:
        try:
            import os

            os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
            from datasets import load_dataset

            ds = load_dataset("openai/gsm8k", "main", split="test")
            _GSM = {
                str(row["question"]).strip(): str(row["answer"])  # type: ignore[index]
                for row in ds
            }
        except Exception:
            _GSM = {}
    for q, a in _GSM.items():
        head = q[:80]
        if head and head in prompt:
            tail = a.split("####")[-1].strip().replace(",", "")
            try:
                return f"The answer is {int(float(tail))}."
            except Exception:
                return f"The answer is {tail}."
    return None


TTFT = 0.10  # 首 token 前延迟（秒）
TOKEN_DELAY = 0.02  # 每个 token 间隔（秒）
N_TOKENS = 10

# prefix_key -> True（已写入缓存）。进程内存态，POST /__reset 清空。
_cache_store: dict[str, bool] = {}


def _prefix_key(model: str, messages: list) -> str:
    parts = []
    for m in messages or []:
        c = m.get("content") if isinstance(m, dict) else None
        parts.append(c if isinstance(c, str) else json.dumps(c, ensure_ascii=False))
    raw = f"{model}|" + "|".join(parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _ptoks(messages: list) -> int:
    n = 0
    for m in messages or []:
        c = m.get("content") if isinstance(m, dict) else None
        n += len(c) if isinstance(c, str) else len(json.dumps(c, ensure_ascii=False))
    return max(1, n // 4)


def _cache_sim(request: Request, model: str, messages: list) -> tuple[int, int, float]:
    """返回 (cached_tokens, cache_write_tokens, ttft_scale)。"""
    mode = (request.headers.get("x-test-cache") or "").lower()
    key = _prefix_key(model, messages)
    ptoks = _ptoks(messages)
    if mode == "nocache":
        return 0, 0, 1.0
    if mode == "fake":  # 上报命中但不加速
        return max(0, ptoks - 4), 0, 1.0
    hit = _cache_store.get(key, False)
    if not hit:
        _cache_store[key] = True  # 首次：写入缓存
        return 0, max(0, ptoks - 4), 1.15
    return max(0, ptoks - 4), 0, 0.35


@app.post("/__reset")
async def reset_cache():
    _cache_store.clear()
    return {"ok": True}


@app.post("/v1/chat/completions")
async def openai_chat(request: Request):
    body = await request.json()
    if body.get("model") == "force-error":
        return JSONResponse(
            {"error": {"type": "rate_limit_error", "message": "slow down"}},
            status_code=429,
        )
    n = int(request.headers.get("x-test-tokens", N_TOKENS))
    stream = body.get("stream", False)
    messages = body.get("messages") or []
    cached, _write, scale = _cache_sim(request, str(body.get("model", "")), messages)

    if "slow" in str(body.get("model", "")):
        await asyncio.sleep(30)  # 模拟很慢的上游，用于验证预热进度与超时

    if "correct" in str(body.get("model", "")):
        # 会答对的模型：用于验证"非零分数"的解析（全 0 分无法证明解析正确）
        prompt = "\n".join(str(m.get("content", "")) for m in messages)
        ans = _gsm_lookup(prompt)
        if ans:
            return JSONResponse(
                {
                    "choices": [
                        {"index": 0, "message": {"role": "assistant", "content": ans}}
                    ],
                    "usage": {
                        "prompt_tokens": _ptoks(messages),
                        "completion_tokens": 8,
                        "total_tokens": _ptoks(messages) + 8,
                    },
                }
            )

    if not stream:
        await asyncio.sleep(TTFT * scale + TOKEN_DELAY * n)
        return JSONResponse(
            {
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": " ".join(f"tok{i}" for i in range(n)),
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": _ptoks(messages),
                    "completion_tokens": n,
                    "total_tokens": _ptoks(messages) + n,
                    # OpenAI 结构的缓存命中（随请求前缀动态变化）
                    "prompt_tokens_details": {"cached_tokens": cached},
                },
            }
        )

    async def gen():
        await asyncio.sleep(TTFT * scale)
        for i in range(n):
            chunk = {"choices": [{"delta": {"content": f"tok{i} "}, "index": 0}]}
            yield f"data: {json.dumps(chunk)}\n\n"
            if i != n - 1:
                await asyncio.sleep(TOKEN_DELAY)
        final = {
            "choices": [{"delta": {}, "finish_reason": "stop", "index": 0}],
            "usage": {
                "prompt_tokens": _ptoks(messages),
                "completion_tokens": n,
                "total_tokens": _ptoks(messages) + n,
                "prompt_tokens_details": {"cached_tokens": cached},
            },
        }
        yield f"data: {json.dumps(final)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/v1/messages")
async def anthropic_messages(request: Request):
    body = await request.json()
    n = int(request.headers.get("x-test-tokens", N_TOKENS))
    messages = body.get("messages") or []
    cached, write, scale = _cache_sim(request, str(body.get("model", "")), messages)
    ptoks = _ptoks(messages)

    async def gen():
        # Anthropic 语义：input_tokens 只含未命中部分（缓存单独列）
        start_usage = {
            "input_tokens": max(0, ptoks - cached - write),
            "output_tokens": 0,
            "cache_read_input_tokens": cached,
            "cache_creation_input_tokens": write,
        }
        yield f"event: message_start\ndata: {json.dumps({'type': 'message_start', 'message': {'usage': start_usage}})}\n\n"
        await asyncio.sleep(TTFT * scale)
        for i in range(n):
            ev = {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": f"tok{i} "},
            }
            yield f"event: content_block_delta\ndata: {json.dumps(ev)}\n\n"
            if i != n - 1:
                await asyncio.sleep(TOKEN_DELAY)
        yield f"event: message_delta\ndata: {json.dumps({'type': 'message_delta', 'usage': {'output_tokens': n}})}\n\n"
        yield f"event: message_stop\ndata: {json.dumps({'type': 'message_stop'})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")
