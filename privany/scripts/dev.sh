#!/usr/bin/env bash
# Start/stop the backend + demo shops for local development.
#   ./scripts/dev.sh start     (rules engine unless GEMINI_API_KEY is set)
#   ./scripts/dev.sh stop
#   ./scripts/dev.sh restart
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="${PRIVANY_RUN_DIR:-$ROOT/.run}"
mkdir -p "$RUN"

start() {
  # only the server process goes to the background, with its own stdin/stdout/stderr,
  # so nothing keeps the caller's terminal or pipe open
  if [ ! -f "$RUN/demo.pid" ] || ! kill -0 "$(cat "$RUN/demo.pid")" 2>/dev/null; then
    cd "$ROOT/demo-site"
    python3 build.py >/dev/null
    nohup python3 serve.py </dev/null >"$RUN/demo.log" 2>&1 &
    echo $! >"$RUN/demo.pid"
  fi
  cd "$ROOT/backend"
  PRIVANY_ALLOW_LOCAL=1 nohup python3 -m uvicorn privany.main:app --host 127.0.0.1 --port 8787 --no-access-log \
    </dev/null >"$RUN/api.log" 2>&1 &
  echo $! >"$RUN/api.pid"
  cd "$ROOT"
  for _ in $(seq 1 20); do curl -sf localhost:8787/health >/dev/null 2>&1 && break; sleep 0.5; done
  echo "backend:      http://localhost:8787  ($(curl -s localhost:8787/health))"
  echo "BrightCart:   http://brightcart.localhost:8090"
  echo "Honest Goods: http://honestgoods.localhost:8091"
}

free_port() {  # kill whatever still holds a port (stale server from an earlier run)
  local pids
  pids=$(lsof -ti "tcp:$1" 2>/dev/null || true)
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
}

stop() {
  for f in api demo; do
    if [ -f "$RUN/$f.pid" ]; then kill "$(cat "$RUN/$f.pid")" 2>/dev/null || true; rm -f "$RUN/$f.pid"; fi
  done
  for port in 8787 8090 8091; do free_port $port; done
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) [ -f "$RUN/api.pid" ] && { kill "$(cat "$RUN/api.pid")" 2>/dev/null || true; rm -f "$RUN/api.pid"; }; free_port 8787; sleep 1; start ;;
  *) echo "usage: $0 start|stop|restart"; exit 1 ;;
esac
