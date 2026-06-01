"""
Thin wrapper around the cmux CLI.

Confirmed against a real machine (cmux 0.64+):

  list-workspaces --json   -> { "window_ref": "...", "workspaces": [ {
        "ref": "workspace:4",          # stable handle; accepted by --workspace (verified)
        "title": "Bowtie",             # human label
        "current_directory": "/abs/path",
        "index": 0,
        "listening_ports": [],
        "selected": false,
        "latest_conversation_message": "...",   # last agent message (shown on cards)
        ... (no git branch / PR fields exposed here)
  } ] }

  list-notifications --json -> [ {
        "tab_title": "Bowtie",          # joins to workspace title
        "title": "Claude Code",         # app name
        "subtitle": "Completed in bowtie" | "Waiting" | ...,   # the KIND of attention
        "body": "Claude is waiting for your input" | "...",
        "is_read": false, "created_at": "...", + workspace_id/surface_id UUIDs
  } ]

IMPORTANT — cmux fires a notification for SEVERAL different states, not just
permission prompts:
  - "Completed in <ws>"  -> task finished
  - "Waiting"            -> Claude yielded the turn; it's your move (NOT a prompt)
  - (a real permission prompt, when one occurs)
So a notification means "this workspace wants you", but it does NOT mean
"approve something". We classify the notification for the badge, and we detect
an actual approvable prompt from the SCREEN (detect_approval), never from the
notification alone.

JOIN: notifications carry a workspace_id UUID absent from list-workspaces; the
only shared field is tab_title <-> title.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass, asdict, field
from typing import Any

from .config import settings

_MAX_LINE = 160


class CmuxError(RuntimeError):
    pass


def _cmux_bin() -> str:
    if settings.cmux_bin:
        return settings.cmux_bin
    found = shutil.which("cmux")
    if not found:
        raise CmuxError(
            "cmux CLI not found on PATH. Set CMUX_BIN in .env to the absolute "
            "path (find it with: which cmux, run inside a cmux pane)."
        )
    return found


def _run(args: list[str], timeout: float = 5.0) -> str:
    cmd = [_cmux_bin(), *args]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except FileNotFoundError as e:
        raise CmuxError(f"cmux binary missing: {e}") from e
    except subprocess.TimeoutExpired as e:
        raise CmuxError(
            f"cmux timed out after {timeout}s running {' '.join(args)}. "
            "If this is the relay/socket being refused, see the "
            "CMUX_SOCKET_MODE note in the README."
        ) from e
    if proc.returncode != 0:
        raise CmuxError(
            f"cmux {' '.join(args)} exited {proc.returncode}: {proc.stderr.strip()}"
        )
    return proc.stdout


def _try_json(args: list[str], timeout: float = 5.0) -> Any | None:
    try:
        out = _run([*args, "--json"], timeout=timeout)
    except CmuxError:
        return None
    out = out.strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def _clean(msg: str | None) -> str | None:
    if not msg:
        return None
    s = msg.strip().strip('"').strip()
    s = s.splitlines()[0] if s else s
    return (s[:_MAX_LINE] + "\u2026") if len(s) > _MAX_LINE else s


def _kind(n: dict) -> str:
    """Classify a notification into the kind of attention it represents.

    Returns: 'completed' | 'waiting' | 'other'. This drives the BADGE only —
    it never enables Approve/Deny (that requires detect_approval on the screen).
    """
    sub = (n.get("subtitle") or "").strip().lower()
    body = (n.get("body") or "").strip().lower()
    if "completed" in sub:
        return "completed"
    if sub == "waiting" or "waiting for your input" in body or "waiting for input" in body:
        return "waiting"
    return "other"


def detect_approval(screen: str | None) -> bool:
    """True only if the screen shows an actual Claude Code permission picker.

    Conservative on purpose: a false positive would show an Approve button for
    something that isn't a prompt (and approving would type '1' as a message).
    So we require the recognisable numbered Yes/No picker, not just any text.

    TODO(verify): widen the patterns if your prompts use different wording.
    """
    if not screen:
        return False
    if "want to proceed" in screen.lower():
        return True
    has_yes = re.search(r"(?m)^[\s\u276f>]*1\.\s*Yes\b", screen) is not None
    has_no = re.search(r"(?m)^[\s\u276f>]*\d\.\s*No\b", screen) is not None
    return has_yes and has_no


# ---------------------------------------------------------------------------

@dataclass
class Workspace:
    id: str                       # cmux ref, e.g. "workspace:4"
    name: str                     # title, e.g. "Bowtie"
    cwd: str | None = None
    branch: str | None = None     # not exposed by the CLI today
    pr: str | None = None         # not exposed by the CLI today
    ports: list[str] = field(default_factory=list)
    status: str = "idle"          # needs_you | active | idle
    attention_kind: str | None = None  # completed | waiting | other | None
    last_line: str | None = None
    needs_attention: bool = False
    selected: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def _target(workspace_ref: str) -> list[str]:
    """--workspace argument. Verified: cmux accepts the ref ('workspace:4')."""
    return ["--workspace", workspace_ref]


def list_workspaces() -> list[Workspace]:
    data = _try_json(["list-workspaces"])
    workspaces: list[Workspace] = []

    rows = data.get("workspaces") if isinstance(data, dict) else (
        data if isinstance(data, list) else None
    )

    if isinstance(rows, list):
        for w in rows:
            workspaces.append(
                Workspace(
                    id=str(w.get("ref") or w.get("title") or w.get("index")),
                    name=str(w.get("title") or w.get("ref") or "untitled"),
                    cwd=w.get("current_directory"),
                    ports=[str(p) for p in (w.get("listening_ports") or [])],
                    last_line=_clean(w.get("latest_conversation_message")),
                    selected=bool(w.get("selected", False)),
                    status="active",
                )
            )
    else:
        raw = _run(["list-workspaces"])
        for line in raw.splitlines():
            line = line.strip()
            if line:
                workspaces.append(Workspace(id=line, name=line, status="active"))

    _apply_notifications(workspaces)
    return workspaces


def list_notifications(unread_only: bool = False) -> list[dict]:
    data = _try_json(["list-notifications"])
    if not isinstance(data, list):
        try:
            raw = _run(["list-notifications"])
        except CmuxError:
            return []
        return [{"tab_title": None, "body": l.strip(), "is_read": False}
                for l in raw.splitlines() if l.strip()]
    if unread_only:
        return [n for n in data if not n.get("is_read", False)]
    return data


def _apply_notifications(workspaces: list[Workspace]) -> None:
    """Flag workspaces with an UNREAD notification. Sets attention_kind for the
    badge. Does NOT decide approvability — that's detect_approval on the screen.
    Keeps the workspace's latest_conversation_message as last_line (more useful
    than the generic notification body)."""
    by_title = {w.name: w for w in workspaces}
    for n in list_notifications(unread_only=True):
        target = by_title.get(str(n.get("tab_title")))
        if target:
            target.needs_attention = True
            target.status = "needs_you"
            target.attention_kind = _kind(n)
            if not target.last_line:
                target.last_line = _clean(n.get("subtitle") or n.get("body"))


def read_screen(workspace_ref: str, lines: int | None = None) -> str:
    args = ["read-screen", *_target(workspace_ref)]
    if lines:
        args += ["--lines", str(lines)]
    return _run(args, timeout=4.0)


def send_text(workspace_ref: str, text: str) -> None:
    _run(["send", *_target(workspace_ref), text], timeout=4.0)


def send_key(workspace_ref: str, key: str) -> None:
    """TODO(verify): cmux key naming ('Return', 'Escape', 'C-c', ...)."""
    _run(["send-key", *_target(workspace_ref), key], timeout=4.0)
