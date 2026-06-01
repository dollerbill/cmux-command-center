"""
Telegram push notifications (optional, best-effort).

Reuses the Telegram pipe you already run for Hermes so a 'session needs you'
alert reaches your phone without building a PWA / web-push stack. If the bot
token + chat id aren't configured, every function here is a silent no-op, so
the server runs fine without it.

Uses stdlib urllib only — no extra dependency.
"""
from __future__ import annotations

import urllib.parse
import urllib.request

from .config import settings


def notify_pending(note: dict) -> bool:
    """Format a cmux notification and push it. Returns True if actually sent."""
    msg = note.get("message") or "A cmux workspace needs your attention."
    ws = note.get("workspace") or note.get("workspaceId") or note.get("name")
    text = f"\u26a0\ufe0f cmux: {ws or 'a session'} needs you\n{msg}"
    return send_telegram(text)


def send_telegram(text: str) -> bool:
    if not (settings.telegram_bot_token and settings.telegram_chat_id):
        return False  # not configured — no-op stub
    url = f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage"
    data = urllib.parse.urlencode(
        {"chat_id": settings.telegram_chat_id, "text": text}
    ).encode()
    try:
        with urllib.request.urlopen(url, data=data, timeout=5) as r:
            return r.status == 200
    except Exception:
        # Never let a failed notification take down the poll loop.
        return False
