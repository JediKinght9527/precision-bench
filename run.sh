#!/usr/bin/env bash
# 启动 Precision Bench（前台运行，适合调试）
# 作为常驻服务请用：./service.sh install
set -euo pipefail
cd "$(dirname "$0")"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8787}"

if [ ! -x ".venv/bin/python" ]; then
  echo "首次运行，正在同步依赖…"
  uv sync
fi

# 运行状态（Engine / BenchManager / SSE 订阅）都在进程内存里，必须单进程。
# 不要加 --workers，多个 worker 会各看各的运行状态。
echo "Precision Bench → http://${HOST}:${PORT}"
exec .venv/bin/python -m uvicorn server.main:app --host "$HOST" --port "$PORT" --no-access-log
