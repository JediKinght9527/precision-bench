"""协议适配器：OpenAI 兼容 + Anthropic，流式打点。

打点口径：
  t0            = 请求发出（time.perf_counter）
  ttft          = 首个「内容 token」到达 - t0
  e2e           = 末 token 到达 - t0
  itl           = 相邻内容 chunk 间隔
  out_tokens    = 优先 usage，缺失则 tiktoken / 估算（estimated=True）
"""

from __future__ import annotations

import json
import socket
import ssl
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from .schemas import Provider, RunConfig, Target

try:  # tiktoken 可能因无法联网下载词表而失败
    import tiktoken as _tiktoken
except Exception:  # pragma: no cover
    _tiktoken = None

_ENC_CACHE: dict[str, Any] = {}


def _encoding(model: str) -> Any:
    if _tiktoken is None:
        return None
    if model in _ENC_CACHE:
        return _ENC_CACHE[model]
    try:
        enc = _tiktoken.encoding_for_model(model)
    except Exception:
        try:
            enc = _tiktoken.get_encoding("cl100k_base")
        except Exception:
            enc = None
    _ENC_CACHE[model] = enc
    return enc


def count_tokens(text: str, model: str) -> tuple[int, bool]:
    """返回 (token 数, 是否估算)。"""
    if not text:
        return 0, False
    enc = _encoding(model)
    if enc is not None:
        try:
            return len(enc.encode(text)), False
        except Exception:
            pass
    return max(1, round(len(text) / 4)), True


def cache_from_usage(u: dict | None) -> tuple[int, int]:
    """把各厂商的缓存字段归一成 (命中, 写入)。

    兼容（按调研）：
      OpenAI / GLM / Qwen : usage.prompt_tokens_details.cached_tokens
      Anthropic           : usage.cache_read_input_tokens / cache_creation_input_tokens
      DeepSeek            : usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens
      Kimi                : usage.cached_tokens（扁平）
      Gemini              : usageMetadata.cached_content_token_count
    """
    if not u:
        return 0, 0
    d = u.get("prompt_tokens_details") or {}
    hit = (d.get("cached_tokens")
           or u.get("cached_tokens")
           or u.get("prompt_cache_hit_tokens")
           or u.get("cache_read_input_tokens")
           or u.get("cached_content_token_count")
           or 0)
    write = (d.get("cache_write_tokens")
             or u.get("cache_creation_input_tokens")
             or 0)
    try:
        return int(hit), int(write)
    except (TypeError, ValueError):
        return 0, 0


@dataclass
class RequestResult:
    ok: bool = False
    status_code: int | None = None
    ttft_ms: float | None = None
    e2e_ms: float | None = None
    tpot_ms: float | None = None
    itl_mean_ms: float | None = None
    itl_p99_ms: float | None = None
    out_tokens: int = 0
    in_tokens: int = 0
    cached_tokens: int = 0
    cache_write_tokens: int = 0
    tokens_estimated: bool = False
    bytes_rx: int = 0
    error_class: str | None = None
    error_msg: str | None = None
    conn_reused: bool | None = None
    dns_ms: float | None = None
    tcp_ms: float | None = None
    tls_ms: float | None = None
    text: str = ""
    itls: list[float] = field(default_factory=list)


def classify_error(
    status: int | None, body: str, exc: Exception | None
) -> tuple[str, str]:
    if exc is not None:
        name = type(exc).__name__
        msg = str(exc)[:400]
        low = msg.lower()
        if (
            isinstance(
                exc,
                (
                    httpx.ConnectTimeout,
                    httpx.ReadTimeout,
                    httpx.WriteTimeout,
                    httpx.PoolTimeout,
                ),
            )
            or "timeout" in low
        ):
            return "timeout", msg
        if "ssl" in low or "certificate" in low:
            return "tls_error", msg
        if (
            isinstance(exc, (httpx.ConnectError, httpx.NetworkError))
            or "connect" in low
        ):
            return "connect_error", msg
        return "client_error", f"{name}: {msg}"
    low = (body or "").lower()
    if status == 401 or status == 403:
        return "auth", body[:400]
    if status == 429:
        return "rate_limit", body[:400]
    if status in (503, 529):
        return "overloaded", body[:400]
    if status == 404:
        return "model_not_found", body[:400]
    if status == 400:
        if any(
            k in low
            for k in (
                "context length",
                "context_length",
                "maximum context",
                "too long",
                "context_length_exceeded",
            )
        ):
            return "context_length", body[:400]
        if any(
            k in low
            for k in ("content filter", "content_policy", "content_filter", "safety")
        ):
            return "content_filter", body[:400]
        return "invalid_request", body[:400]
    if status and status >= 500:
        return "server_error", body[:400]
    if status and status >= 400:
        return "http_error", body[:400]
    return "protocol_error", body[:400]


def _phase_probe(
    host: str, port: int, use_tls: bool
) -> tuple[float | None, float | None, float | None]:
    """冷连接模式下的 DNS/TCP/TLS 分段时间（best-effort）。"""
    dns = tcp = tls = None
    try:
        t = time.perf_counter()
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
        dns = (time.perf_counter() - t) * 1000
        if not infos:
            return dns, None, None
        af, stype, proto, _, addr = infos[0]
        t = time.perf_counter()
        raw = socket.socket(af, stype, proto)
        raw.settimeout(10)
        raw.connect(addr)
        tcp = (time.perf_counter() - t) * 1000
        if use_tls:
            t = time.perf_counter()
            ctx = ssl.create_default_context()
            wrapped = ctx.wrap_socket(raw, server_hostname=host)
            tls = (time.perf_counter() - t) * 1000
            wrapped.close()
        else:
            raw.close()
    except Exception:
        pass
    return dns, tcp, tls


def _body_common(target: Target, cfg: RunConfig) -> dict:
    tr = cfg.traffic
    body: dict = {
        "model": target.model,
        "temperature": tr.temperature,
        "max_tokens": tr.max_tokens,
    }
    if tr.top_p is not None:
        body["top_p"] = tr.top_p
    body.update(target.extra_body or {})
    return body


def _endpoint(target: Target, default_path: str) -> str:
    if target.path:
        p = target.path
    else:
        p = default_path
    base = target.base_url.rstrip("/")
    # 去重 /v1
    if base.endswith("/v1") and p.startswith("/v1"):
        p = p[3:]
    return base + p


def _headers(target: Target, provider: Provider) -> dict:
    h: dict[str, str] = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    if provider == Provider.anthropic:
        h["x-api-key"] = target.api_key
        h["anthropic-version"] = "2023-06-01"
        if target.api_key and target.api_key.startswith("sk-ant"):
            h["Authorization"] = f"Bearer {target.api_key}"
    else:
        h["Authorization"] = f"Bearer {target.api_key}"
    h.update(target.extra_headers or {})
    return h


async def execute(
    client: httpx.AsyncClient,
    target: Target,
    cfg: RunConfig,
    messages: list[dict],
    model_tokens: int,
    timeout: float | None = None,
) -> RequestResult:
    res = RequestResult()
    tr = cfg.traffic
    if target.provider == Provider.anthropic:
        url = _endpoint(target, "/v1/messages")
        body = _body_common(target, cfg)
        body["messages"] = messages
        if tr.max_tokens:
            body["max_tokens"] = tr.max_tokens
        if cfg.stream:
            body["stream"] = True
    else:
        url = _endpoint(target, "/v1/chat/completions")
        body = _body_common(target, cfg)
        body["messages"] = messages
        if cfg.stream:
            body["stream"] = True
            body["stream_options"] = {"include_usage": True}

    if not cfg.connection_reuse and target.provider is not None:
        try:
            u = httpx.URL(url)
            res.dns_ms, res.tcp_ms, res.tls_ms = _phase_probe(
                u.host,
                u.port or (443 if u.scheme == "https" else 80),
                u.scheme == "https",
            )
        except Exception:
            pass

    t0 = time.perf_counter()
    try:
        if not cfg.stream:
            resp = await client.post(
                url, headers=_headers(target, target.provider), json=body, timeout=timeout
            )
            res.status_code = resp.status_code
            data = resp.content
            res.bytes_rx = len(data)
            if resp.status_code >= 400:
                res.error_class, res.error_msg = classify_error(
                    resp.status_code, resp.text, None
                )
                return res
            try:
                j = resp.json()
            except Exception:
                res.error_class, res.error_msg = "protocol_error", resp.text[:400]
                return res
            res.e2e_ms = (time.perf_counter() - t0) * 1000
            res.ttft_ms = res.e2e_ms
            text, out_tok, in_tok = _extract_nonstream(j, target.provider)
            cache_hit, cache_write = cache_from_usage(j.get("usage"))
            if out_tok is None:
                out_tok, est = count_tokens(text, target.model)
                res.tokens_estimated = est
            res.out_tokens = out_tok
            res.in_tokens = in_tok if in_tok else model_tokens
            # Anthropic 语义：input_tokens 不含缓存部分（cache_read/creation 单列）。
            # 统一归一成「总输入 token」，与 OpenAI 的 prompt_tokens（含命中）口径一致，
            # 否则缓存命中率分母错、吞吐被带歪。
            if target.provider == Provider.anthropic and (cache_hit or cache_write):
                res.in_tokens = res.in_tokens + cache_hit + cache_write
            res.cached_tokens = cache_hit
            res.cache_write_tokens = cache_write
            res.text = text
            res.ok = True
            return res

        async with client.stream(
            "POST", url, headers=_headers(target, target.provider), json=body, timeout=timeout
        ) as resp:
            res.status_code = resp.status_code
            if resp.status_code >= 400:
                raw = await resp.aread()
                res.bytes_rx = len(raw)
                res.error_class, res.error_msg = classify_error(
                    resp.status_code, raw.decode("utf-8", "replace"), None
                )
                return res
            content_events: list[float] = []
            text_parts: list[str] = []
            usage_out = None
            usage_in = None
            first_ts: float | None = None
            last_ts = t0
            got_content = False
            async for line in resp.aiter_lines():
                if not line:
                    continue
                res.bytes_rx += len(line) + 1
                if not line.startswith("data:"):
                    # Anthropic 有 event: 行，data 行照常处理；忽略其它
                    if line.startswith("event:"):
                        continue
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    obj = json.loads(payload)
                except Exception:
                    continue
                now = time.perf_counter()
                if target.provider == Provider.anthropic:
                    etype = obj.get("type")
                    if etype == "message_start":
                        u = obj.get("message", {}).get("usage") or {}
                        if u.get("input_tokens") is not None:
                            usage_in = u["input_tokens"]
                        # Anthropic 的缓存字段在 message_start.usage 里（流式唯一机会）
                        ch, cw = cache_from_usage(u)
                        res.cached_tokens, res.cache_write_tokens = ch, cw
                        # Anthropic 语义：input_tokens 不含缓存部分，就地归一成总输入，
                        # 流式末尾统一从 usage_in 赋值（中途改 res.in_tokens 会被覆盖）
                        if (ch or cw) and usage_in is not None:
                            usage_in = usage_in + ch + cw
                    elif etype == "content_block_delta":
                        delta = obj.get("delta") or {}
                        if delta.get("type") == "text_delta" and delta.get("text"):
                            content_events.append(now)
                            if not got_content:
                                got_content = True
                                first_ts = now
                            text_parts.append(delta["text"])
                            last_ts = now
                    elif etype == "message_delta":
                        u = obj.get("usage") or {}
                        if u.get("output_tokens") is not None:
                            usage_out = u["output_tokens"]
                    elif etype == "error":
                        res.error_class = "protocol_error"
                        res.error_msg = json.dumps(obj)[:400]
                        return res
                else:
                    choices = obj.get("choices") or []
                    if obj.get("usage"):
                        u = obj["usage"]
                        if u.get("completion_tokens") is not None:
                            usage_out = u["completion_tokens"]
                        if u.get("prompt_tokens") is not None:
                            usage_in = u["prompt_tokens"]
                        ch, cw = cache_from_usage(u)
                        res.cached_tokens, res.cache_write_tokens = ch, cw
                    delta_text = ""
                    if choices:
                        delta = choices[0].get("delta") or {}
                        delta_text = delta.get("content") or ""
                    if delta_text:
                        content_events.append(now)
                        if not got_content:
                            got_content = True
                            first_ts = now
                        text_parts.append(delta_text)
                        last_ts = now

            end = time.perf_counter()
            res.e2e_ms = (end - t0) * 1000
            if not got_content:
                res.error_class, res.error_msg = (
                    "empty_response",
                    "未收到任何内容 token",
                )
                return res
            res.ttft_ms = (first_ts - t0) * 1000 if first_ts else res.e2e_ms
            # ITL
            if len(content_events) > 1:
                itls = [
                    (content_events[i] - content_events[i - 1]) * 1000
                    for i in range(1, len(content_events))
                ]
                res.itls = itls
                res.itl_mean_ms = sum(itls) / len(itls)
                res.itl_p99_ms = _pct(itls, 99)
            text = "".join(text_parts)
            res.text = text
            if usage_out is None:
                out_tok, est = count_tokens(text, target.model)
                res.out_tokens = out_tok
                res.tokens_estimated = est
            else:
                res.out_tokens = usage_out
            res.in_tokens = usage_in if usage_in is not None else model_tokens
            if (
                res.out_tokens
                and res.out_tokens > 1
                and res.e2e_ms is not None
                and res.ttft_ms is not None
            ):
                res.tpot_ms = (res.e2e_ms - res.ttft_ms) / (res.out_tokens - 1)
            res.ok = True
            return res
    except Exception as exc:  # noqa: BLE001
        res.status_code = res.status_code
        res.error_class, res.error_msg = classify_error(res.status_code, "", exc)
        if res.e2e_ms is None:
            res.e2e_ms = (time.perf_counter() - t0) * 1000
        return res


def _extract_nonstream(
    j: dict, provider: Provider
) -> tuple[str, int | None, int | None]:
    if provider == Provider.anthropic:
        parts = [
            b.get("text", "")
            for b in (j.get("content") or [])
            if b.get("type") == "text"
        ]
        text = "".join(parts)
        u = j.get("usage") or {}
        return text, u.get("output_tokens"), u.get("input_tokens")
    choices = j.get("choices") or []
    text = ""
    if choices:
        text = (choices[0].get("message") or {}).get("content") or ""
    u = j.get("usage") or {}
    return text, u.get("completion_tokens"), u.get("prompt_tokens")


def _pct(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * p / 100
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


async def probe(
    client: httpx.AsyncClient, target: Target, cfg: RunConfig
) -> RequestResult:
    """单次探活/测速：强制采集 DNS/TCP/TLS 分段耗时后跑一次请求。"""
    try:
        u = httpx.URL(
            _endpoint(
                target,
                "/v1/messages"
                if target.provider == Provider.anthropic
                else "/v1/chat/completions",
            )
        )
        port = u.port or (443 if u.scheme == "https" else 80)
        dns, tcp, tls = _phase_probe(u.host, port, u.scheme == "https")
    except Exception:
        dns = tcp = tls = None
    res = await execute(client, target, cfg, [{"role": "user", "content": "hi"}], 1)
    res.dns_ms, res.tcp_ms, res.tls_ms = dns, tcp, tls
    return res
