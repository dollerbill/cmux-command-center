#!/usr/bin/env bash
# Start the cmux command center. Run from anywhere; it cds to its own dir.
set -euo pipefail
cd "$(dirname "$0")"

# Load .env if present.
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

# venv + deps.
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
. .venv/bin/activate
pip install -q -r requirements.txt

HOST="${CMUX_SERVER_HOST:-0.0.0.0}"
PORT="${CMUX_SERVER_PORT:-8765}"

echo "cmux command center -> http://${HOST}:${PORT}"
echo "On your tailnet, reach it at:  http://<laptop-tailscale-hostname>:${PORT}"
exec uvicorn app.main:app --host "$HOST" --port "$PORT"
