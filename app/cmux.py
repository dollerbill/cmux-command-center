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

JOIN: notifications carry a workspace_id UUID. list-workspaces exposes the same
UUID as "id" when called with `--id-format both`, so we join on
notification.workspace_id <-> workspace "id" (UUID). tab_title <-> title is kept
only as a fallback when a UUID is missing. (Earlier builds were thought to expose
no shared id; --id-format both does.)
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


def rpc(method: str, params: dict | None = None, timeout: float = 5.0) -> Any | None:
    """Call a cmux socket RPC method and return parsed JSON (or None).

    cmux exposes structured RPCs over its socket (see `cmux capabilities`),
    invoked as `cmux rpc <method> <json-params>`. We use this for the Feed
    permission API, which is more robust than screen-scraping a prompt.
    """
    args = ["rpc", method]
    if params is not None:
        args.append(json.dumps(params))
    out = _run(args, timeout=timeout).strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return out  # some methods return a plain string / ack


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


# --- Permission prompts via the Feed RPC (preferred over screen-scraping) ----
#
# cmux's Feed exposes pending permission prompts as structured items:
#   { "kind": "permissionRequest", "status": "pending",
#     "request_id": "claude-<session>-PermissionRequest-<tool>-<ts>",
#     "title": "Edit", "tool_name": "Edit", "tool_input": "{...}",
#     "cwd": "/abs/path", "workstream_id": "claude-..." }
# (verified via `cmux rpc feed.list`). There is NO workspace_id on feed items,
# so we join a pending request to a workspace by cwd == current_directory.
#
# Answering: `feed.permission.reply {request_id, mode}` where mode is one of
#   once | always | all | bypass | deny   (verified from the validation error).
# Approve -> "once" (this action only); Deny -> "deny".

_APPROVE_MODE = "once"
_DENY_MODE = "deny"


def pending_permission(workspace_cwd: str | None) -> dict | None:
    """Return the pending permissionRequest feed item for this workspace, if any.

    Joins on cwd (the only workspace linkage feed items expose). Returns the
    raw item dict (so callers can show title/tool_name and reply by request_id),
    or None when nothing is awaiting approval.
    """
    feed = rpc("feed.list")
    items = feed.get("items") if isinstance(feed, dict) else None
    if not isinstance(items, list):
        return None
    matches = [
        it for it in items
        if it.get("kind") == "permissionRequest"
        and it.get("status") == "pending"
        and it.get("request_id")
        and (workspace_cwd is None or it.get("cwd") == workspace_cwd)
    ]
    if not matches:
        return None
    # A workspace can have several pending requests queued at once (each tool
    # call makes its own). Answer the most recent — that's the one on screen.
    return max(matches, key=lambda it: it.get("created_at") or "")


def reply_permission(request_id: str, approve: bool) -> Any | None:
    """Answer a pending permission prompt via the Feed RPC."""
    mode = _APPROVE_MODE if approve else _DENY_MODE
    return rpc("feed.permission.reply", {"request_id": request_id, "mode": mode})


def detect_approval(screen: str | None) -> bool:
    """FALLBACK heuristic: does the screen *look* like a permission picker?

    Superseded by pending_permission() (the Feed RPC), which is exact. Kept only
    as a degraded signal if the Feed RPC is ever unavailable. Conservative on
    purpose \u2014 a false positive there would type '1' as a chat message.
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
    id: str                       # cmux ref, e.g. "workspace:4" — the routing
                                  # handle the front-end sends back as --workspace.
    uuid: str | None = None       # stable UUID (from --id-format both); the
                                  # reliable join key to notifications.workspace_id.
    name: str = "untitled"        # title, e.g. "Bowtie"
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
    # --id-format both adds the stable UUID ("id") alongside the ref, giving us
    # a reliable notifications.workspace_id join key (verified cmux 0.64+).
    data = _try_json(["list-workspaces", "--id-format", "both"])
    workspaces: list[Workspace] = []

    rows = data.get("workspaces") if isinstance(data, dict) else (
        data if isinstance(data, list) else None
    )

    if isinstance(rows, list):
        for w in rows:
            workspaces.append(
                Workspace(
                    id=str(w.get("ref") or w.get("title") or w.get("index")),
                    uuid=(str(w["id"]) if w.get("id") else None),
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


def get_workspace(workspace_ref: str) -> Workspace | None:
    """Look up a single workspace by its ref (or uuid). Used to resolve the cwd
    needed to join against pending Feed permission requests."""
    for w in list_workspaces():
        if w.id == workspace_ref or w.uuid == workspace_ref:
            return w
    return None


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
    than the generic notification body).

    Join key: notification.workspace_id <-> workspace.uuid (both UUIDs, verified
    to match). This is collision-proof, unlike the old tab_title==title match.
    Falls back to title only when a UUID is missing on either side.
    """
    by_uuid = {w.uuid: w for w in workspaces if w.uuid}
    by_title = {w.name: w for w in workspaces}
    for n in list_notifications(unread_only=True):
        target = by_uuid.get(str(n.get("workspace_id"))) if n.get("workspace_id") else None
        if target is None:
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
    """Send a single named key.

    Verified against cmux 0.64+ (`cmux send-key --help`): keys are lowercase
    names, e.g. `enter`, `escape`, `tab`, and chords like `ctrl+c` / `ctrl+u`
    (NOT tmux-style `Return` / `C-c`). The key-bar and approve/deny callers
    pass these lowercase names.
    """
    _run(["send-key", *_target(workspace_ref), key], timeout=4.0)
