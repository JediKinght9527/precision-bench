#!/usr/bin/env bash
# LLM Bench 常驻服务管理（launchd）
#   ./service.sh install    安装并启动（开机自启 + 崩溃自动重启）
#   ./service.sh status     查看状态
#   ./service.sh logs       跟踪日志
#   ./service.sh restart    重启
#   ./service.sh stop       停止
#   ./service.sh uninstall  卸载并停止
set -euo pipefail
cd "$(dirname "$0")"

LABEL="com.marco.llmbench"
ROOT="$(pwd)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG="$HOME/Library/Logs/llm-bench.log"
ERR="$HOME/Library/Logs/llm-bench.err.log"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8787}"
UID_NUM="$(id -u)"

write_plist() {
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${ROOT}/.venv/bin/python</string>
    <string>-m</string><string>uvicorn</string>
    <string>server.main:app</string>
    <string>--host</string><string>${HOST}</string>
    <string>--port</string><string>${PORT}</string>
    <string>--no-access-log</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${ERR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PYTHONUNBUFFERED</key><string>1</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST_EOF
}

free_port() {
  # 释放端口上手动的 nohup 实例，避免 launchd 绑定失败
  local pids
  pids="$(lsof -tnP -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  sleep 1
}

case "${1:-}" in
  install)
    if [ ! -x ".venv/bin/python" ]; then echo "同步依赖…"; uv sync; fi
    free_port
    write_plist
    launchctl bootout "gui/${UID_NUM}" "$PLIST" 2>/dev/null || true
    launchctl bootstrap "gui/${UID_NUM}" "$PLIST"
    launchctl enable "gui/${UID_NUM}/${LABEL}"
    sleep 3
    echo "已安装并启动：http://${HOST}:${PORT}"
    "$0" status || true
    ;;
  uninstall)
    launchctl bootout "gui/${UID_NUM}" "$PLIST" 2>/dev/null || true
    launchctl disable "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
    rm -f "$PLIST"
    echo "已卸载"
    ;;
  stop)
    launchctl kill SIGTERM "gui/${UID_NUM}/${LABEL}" 2>/dev/null || free_port
    echo "已停止"
    ;;
  restart)
    launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"
    echo "已重启"
    ;;
  status)
    if launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1; then
      printf "launchd：已加载\n"
      launchctl print "gui/${UID_NUM}/${LABEL}" | grep -E "^\s+(state|pid|last exit code) " | sed 's/^/  /'
    else
      printf "launchd：未加载\n"
    fi
    printf "HTTP  ："
    curl -s -m 3 -o /dev/null -w "%{http_code}\n" "http://${HOST}:${PORT}/api/health" || echo "无响应"
    printf "日志  ：%s\n" "$LOG"
    ;;
  logs)
    tail -f "$LOG" "$ERR"
    ;;
  *)
    sed -n '2,12p' "$0"
    ;;
esac
