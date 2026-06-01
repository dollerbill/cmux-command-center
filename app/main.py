"""
FastAPI app: the cmux command center backend.

Routes:
  GET  /api/health                 -> can we talk to cmux?
  GET  /api/workspaces             -> grouped { needs_you: [...], active: [...] }
  GET  /api/notifications          -> raw cmux notifications
  GET  /api/session/{ws}/screen    -> { text } current surface (display only)
  POST /api/session/{ws}/send      -> { text, enter } send text to the pane
  POST /api/session/{ws}/key       -> { key } send a single named key
  POST /api/session/{ws}/approve   -> answer a pending permission prompt: YES
  POST /api/session/{ws}/deny      -> answer a pending permission prompt: NO
  GET  /                           -> the dashboard (static/)

A background loop polls notifications and pushes new ones to Telegram.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import cmux
from .config import settings
from .notify import notify_pending

STATIC = Path(__file__).resolve().parent.parent / "static"


class SendBody(BaseModel):
    text: str
    enter: bool = True


class KeyBody(BaseModel):
    key: str


def _grouped() -> dict:
    """Group workspaces into what needs the human vs everything else.

    v1 is intentionally honest: cmux alone reliably tells us 'needs attention'
    (via notifications) but not review/done. Richer status is an extension
    point — the natural way to add it is the per-session markdown convention
    (goal/status/DoD) from the orchestrator pattern, read here and merged in.
    """
    groups: dict[str, list] = {"needs_you": [], "active": []}
    for w in cmux.list_workspaces():
        bucket = "needs_you" if w.needs_attention else "active"
        groups[bucket].append(w.to_dict())
    return groups


# --- background notification poll -> Telegram push (best effort) -----------

async def _poll_loop() -> None:
    seen: set[str] = set()
    while True:
        try:
            notes = await asyncio.to_thread(cmux.list_notifications)
            for n in notes:
                key = f"{n.get('workspace')}|{n.get('message')}"
                if key not in seen:
                    seen.add(key)
                    await asyncio.to_thread(notify_pending, n)
            if len(seen) > 500:  # bound memory; stale keys get re-pushed once
                seen.clear()
        except Exception:
            pass  # never let the loop die
        await asyncio.sleep(settings.poll_interval)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_poll_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="cmux command center", lifespan=lifespan)


@app.get("/api/health")
def health():
    try:
        cmux.list_workspaces()
        return {"ok": True}
    except cmux.CmuxError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=503)


@app.get("/api/workspaces")
def workspaces():
    try:
        return _grouped()
    except cmux.CmuxError as e:
        raise HTTPException(503, str(e))


@app.get("/api/notifications")
def notifications():
    return cmux.list_notifications()


@app.get("/api/session/{ws}/screen")
def screen(ws: str):
    try:
        text = cmux.read_screen(ws)
        return {"text": text, "pending_approval": cmux.detect_approval(text)}
    except cmux.CmuxError as e:
        raise HTTPException(503, str(e))


@app.post("/api/session/{ws}/send")
def send(ws: str, body: SendBody):
    try:
        cmux.send_text(ws, body.text)
        if body.enter:
            cmux.send_key(ws, "Return")
        return {"ok": True}
    except cmux.CmuxError as e:
        raise HTTPException(503, str(e))


@app.post("/api/session/{ws}/key")
def key(ws: str, body: KeyBody):
    try:
        cmux.send_key(ws, body.key)
        return {"ok": True}
    except cmux.CmuxError as e:
        raise HTTPException(503, str(e))


# Approve / deny a pending permission prompt.
# VERIFY against your actual Claude Code prompt. This assumes the numbered
# picker (1 = Yes, 3 = No). If your prompt differs, adjust the sequences —
# this is the one genuinely prompt-shape-dependent bit in the server.
@app.post("/api/session/{ws}/approve")
def approve(ws: str):
    try:
        cmux.send_text(ws, "1")
        cmux.send_key(ws, "Return")
        return {"ok": True}
    except cmux.CmuxError as e:
        raise HTTPException(503, str(e))


@app.post("/api/session/{ws}/deny")
def deny(ws: str):
    try:
        cmux.send_text(ws, "3")
        cmux.send_key(ws, "Return")
        return {"ok": True}
    except cmux.CmuxError as e:
        raise HTTPException(503, str(e))


# Static dashboard. Mounted last so /api/* routes take precedence.
app.mount("/", StaticFiles(directory=str(STATIC), html=True), name="static")
