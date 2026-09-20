#!/usr/bin/env bash
# 启动本地假上游（用于演示/自测），OpenAI 兼容 + Anthropic，端口 8899
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8899}"
echo "Mock upstream → http://127.0.0.1:${PORT}  (base_url 填此地址，任意 api_key)"
exec uv run uvicorn tests.mock_upstream:app --host 127.0.0.1 --port "${PORT}"
