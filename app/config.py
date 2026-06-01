"""Env-driven settings for the cmux command center server."""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Settings:
    # Bind on 0.0.0.0 so the laptop is reachable at its Tailscale hostname.
    # (Only your tailnet can route to it; do NOT expose this to the open net.)
    host: str = os.getenv("CMUX_SERVER_HOST", "0.0.0.0")
    port: int = int(os.getenv("CMUX_SERVER_PORT", "8765"))

    # Absolute path to the cmux CLI. Leave unset to resolve via PATH.
    # Find it with: which cmux   (run inside a cmux pane)
    cmux_bin: str | None = os.getenv("CMUX_BIN") or None

    # How often the background loop checks for new notifications (seconds).
    poll_interval: float = float(os.getenv("CMUX_POLL_INTERVAL", "3"))

    # Telegram push (optional). If unset, notify.py is a silent no-op.
    telegram_bot_token: str | None = os.getenv("TELEGRAM_BOT_TOKEN") or None
    telegram_chat_id: str | None = os.getenv("TELEGRAM_CHAT_ID") or None


settings = Settings()
