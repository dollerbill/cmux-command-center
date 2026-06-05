# CLAUDE.md — operating guide for agents on this repo

> `AGENTS.md` is a symlink to this file. One source of truth for every agent tool.
> For the user-facing tour read `README.md`; for the enhancement backlog read `REMAINING.md`.

## What this is

A small self-hosted web dashboard for steering [cmux](https://cmux.com) workspaces
from any device on a Tailscale tailnet: a grouped status board, a terminal-surface
view, send-text / send-key, and approve/deny for pending permission prompts.

```
browser (phone/iPad/laptop, on tailnet)
   │ http
FastAPI server  (app/, runs next to cmux on the laptop)
   │ subprocess → cmux CLI  (list-workspaces / list-notifications / read-screen
   │                         / send / send-key / rpc feed.list / rpc feed.permission.reply)
cmux  (macOS app)
```

The server **shells out to the `cmux` CLI** (`app/cmux.py::_run`). It does not embed
cmux's socket/relay. There is no database, no build step, no front-end framework.

## Layout

| Path | Role |
|---|---|
| `app/main.py` | FastAPI routes + the background notification→Telegram poll loop |
| `app/cmux.py` | the **only** place that talks to cmux; all CLI/RPC shapes live here |
| `app/config.py` | env-driven settings (host/port, `CMUX_BIN`, poll interval, Telegram) |
| `app/notify.py` | best-effort Telegram push (stdlib `urllib`; silent no-op if unconfigured) |
| `static/` | hand-rolled HTML/CSS/JS dashboard — **zero front-end dependencies** |
| `run.sh` | creates `.venv`, installs `requirements.txt`, runs uvicorn |

## Conventions that are load-bearing — don't break these

1. **Zero front-end dependencies is deliberate.** The ANSI→HTML converter in
   `static/app.js` is hand-rolled on purpose (the `ansi_up` CDN 404'd and ships as
   an ES module). Do **not** add a `<script src=cdn…>` or an npm/bundler step.
   No Tailwind, no framework. Keep `static/` inspectable as plain files.

2. **All cmux access goes through `app/cmux.py`.** Don't shell out to `cmux` from
   routes or the front-end. New CLI/RPC shapes get documented in that module's
   docstring with a "verified against cmux X.Y" note, the way the existing ones are.

3. **`cmux` is only on PATH inside a cmux pane.** It is *not* on PATH in an
   arbitrary shell (CI, a bare terminal, a subagent). Any "verified live" claim
   must be run where cmux actually is. From elsewhere, `which cmux` returns
   nothing and the app falls back to **demo data** (the connection pill reads
   "demo"). Set `CMUX_BIN` to the absolute path to override PATH resolution.

4. **Security posture: tailnet-only.** The server binds `0.0.0.0` so the Tailscale
   hostname routes to it — which means anything that can reach the host can drive
   sessions. Never port-forward it to the open internet, and never suggest a
   third-party host for it. Bearer-token auth on the mutating routes is the next
   security step (tracked in `REMAINING.md` → P4). Secrets (Telegram creds) live in
   `.env`, which is gitignored — keep it that way.

## The approve/deny invariant (this is where the bugs live)

Two facts about the permission flow that are easy to break:

- **Visibility and action must use the same signal.** The approve/deny bar is
  shown by the `/screen` route and acted on by the `/approve` + `/deny` routes.
  Both resolve "is there a pending prompt?" through **`cmux.pending_permission()`**.
  If you ever let the bar appear from one signal (e.g. the `detect_approval`
  screen-scrape heuristic) while the action depends on another (the Feed), you get
  a dead button (bar shows, click 409s) or a ghost button (bar lingers after the
  prompt is gone). The heuristic is a **fallback only**, used when the Feed can't
  be consulted at all.

- **The permission↔workspace join is by `cwd`, and it's fuzzy.** Feed items carry
  no `workspace_id` — only a `cwd`. `pending_permission()` joins that to the
  workspace's `current_directory`. Paths are normalized (`realpath`,
  trailing-slash) and matched exact → subdirectory-prefix → single-pending
  fallback, because the agent may have `cd`'d into a subdir and macOS symlinks
  (`/var`→`/private/var`) skew raw strings. Do **not** revert this to raw `==`.

  Quick diagnostic when an approve won't land (run in a cmux pane):
  ```sh
  cmux rpc feed.list | jq '.items[] | select(.kind=="permissionRequest") | .cwd'
  cmux list-workspaces --json --id-format both | jq '.workspaces[].current_directory'
  ```

## Verified cmux CLI / RPC contract

Authoritative copy lives in `app/cmux.py`'s module docstring — read it before
touching the wrapper. Summary:

- `list-workspaces --json --id-format both` → `{ workspaces: [{ ref, id (UUID),
  title, current_directory, listening_ports, selected, latest_conversation_message }] }`.
  No git-branch / PR fields are exposed.
- `list-notifications --json` → `[{ tab_title, title, subtitle, body, is_read,
  workspace_id (UUID), surface_id, created_at }]`. A notification means "this
  workspace wants you" — it covers *Completed* and *Waiting* (your turn) too, so it
  **never** by itself means "approve something".
- **Notification → workspace join:** `notification.workspace_id` ↔ workspace `id`
  (both UUIDs, collision-proof). `tab_title ↔ title` is a fallback only.
- **Permission prompts:** `cmux rpc feed.list` → items incl. `{ kind:"permissionRequest",
  status:"pending", request_id, title, tool_name, cwd }`. Answer with
  `feed.permission.reply { request_id, mode }`, `mode ∈ once|always|all|bypass|deny`.
  Approve→`once`, Deny→`deny`. Feed items have **no** workspace_id → join by `cwd`.
- **Targeting** (`read-screen`/`send`/`send-key`) accepts the workspace `ref`
  (e.g. `workspace:4`) as `--workspace`.
- **`send-key` names are lowercase:** `enter`, `escape`, `tab`, `up`, `down`,
  `ctrl+c` — *not* tmux-style `Return`/`C-c`.

## Hardcoded knobs (there are no approval TTLs)

The app keeps **no expiry/TTL on pending approvals** — a prompt stays approvable
until cmux resolves it. The only timing constants are:

- subprocess timeouts in `app/cmux.py::_run` (4–5s) and Telegram `urlopen` (5s);
- front-end poll intervals in `static/app.js`: `POLL_LIST = 4000`ms,
  `POLL_SCREEN = 2000`ms;
- `CMUX_POLL_INTERVAL` (default 3s) for the notification→Telegram loop.

If an approve "does nothing," it is almost never a timeout — check the cwd join.

## Running & checking

- Run: `./run.sh` then open `http://localhost:8765` (or the tailnet hostname).
- There is no test suite yet. To exercise `cmux.py` logic without cmux present,
  monkeypatch `cmux.rpc` / `cmux._run` with canned JSON and call the function
  directly (see how `pending_permission` was verified). Don't add a heavyweight
  test framework for this; stdlib `unittest` or a tiny script is enough.

## House style

- Python: `from __future__ import annotations`, modern `str | None` unions, dataclasses
  for value objects, small pure functions, generous module/function docstrings that
  record *why* and *what was verified live* (match the existing tone).
- Keep diffs small and reversible; prefer hardening an existing function over adding
  a parallel code path. When you resolve a `REMAINING.md` item, leave a
  `✅ RESOLVED` note rather than deleting the entry.
