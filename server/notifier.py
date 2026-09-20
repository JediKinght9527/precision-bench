"""告警通知：通用 Webhook + 飞书机器人。"""

from __future__ import annotations

import httpx


async def send(url: str, kind: str, text: str) -> bool:
    if not url:
        return False
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            if kind == "feishu":
                payload = {"msg_type": "text", "content": {"text": text}}
            else:
                payload = {"text": text}
            resp = await client.post(url, json=payload)
            return resp.status_code < 400
    except Exception:
        return False
