# cmux command center

A small self-hosted web dashboard for steering [cmux](https://cmux.com) workspaces
from any device on your Tailscale tailnet. Grouped status board, terminal surface
view, send-text, and approve/deny for pending permission prompts — rendered
full-screen in the browser on **both** iPhone and iPad (no App Store packaging
limits, which is the gap in Cmux Remote today).

This is **v1**. The core works against real cmux output; known limitations and
planned enhancements are tracked in [`REMAINING.md`](./REMAINING.md).

## What it does

- **Status board** grouped *Needs you* vs *Active*. Attention is driven off
  `cmux list-notifications` (the events Claude Code emits — the same signal that
  lights the sidebar ring), **not** by scraping the screen. Notifications are
  classified by kind for the badge: *done* (Completed), *your turn* (Waiting),
  or generic *needs you*.
- **Terminal surface** of the selected workspace via `cmux read-screen` (for
  *display* — we never parse it to make decisions). Output runs through a small
  self-contained ANSI→HTML converter (no external dependency) and strips
  unrenderable Nerd Font prompt glyphs.
- **Send text** to the active pane, plus a key bar (Esc/Tab/arrows/Ctrl-C/y/n/Enter).
- **Approve / Deny** — shown in the detail pane **only** when cmux's Feed
  reports a *pending* `permissionRequest` for the selected workspace (queried
  via `feed.list`, joined by cwd). Approve answers `feed.permission.reply`
  with `mode:once`, Deny with `mode:deny` — no screen-parsing, no typing "1".
  The bar shows *what* is being approved (e.g. "Allow Bash?"). A
  "Waiting"/"Completed" notification alone never enables approval.
- **Telegram push** when a workspace starts needing you (optional; reuses your
  existing Hermes bot pipe instead of building web-push).

## Architecture

```
browser (iPhone/iPad/laptop, on tailnet)
        |  http
   FastAPI server  (this app, runs next to cmux on the laptop)
        |  subprocess: cmux list-workspaces / list-notifications / read-screen
        |              / send / send-key / rpc feed.list / rpc feed.permission.reply
      cmux  (macOS app)
```

The server shells out to the `cmux` CLI. It does **not** reimplement the relay's
live socket streaming — see `REMAINING.md` (this is also what unlocks real
terminal color; see below).

## Setup

```bash
cd ~/Documents/Projects/cmux-command-center
cp .env.example .env          # optional — only needed for Telegram / overrides
./run.sh                      # creates .venv, installs deps, starts uvicorn
```

Then open `http://localhost:8765` on the laptop, or
`http://<laptop-tailscale-hostname>:8765` from your phone/iPad on the tailnet.
If the API can't reach cmux the page shows **demo data** (the pill reads "demo")
so the layout is still inspectable; once it can, the pill flips to "live".

## Confirmed cmux CLI shapes (verified against a real machine)

These were unknown when the wrapper was first written and are now confirmed in
`app/cmux.py`:

- `list-workspaces --json` → `{ "workspaces": [ { ref, title, current_directory,
  index, listening_ports, selected, latest_conversation_message } ] }`.
  No git branch / PR fields are exposed by the CLI.
- `list-notifications --json` → array of `{ tab_title, title, subtitle, body,
  is_read, workspace_id, surface_id, created_at }`.
- **Join key:** notifications carry a `workspace_id` UUID. `list-workspaces
  --json --id-format both` exposes the same UUID as `id`, so we join on
  **`workspace_id` ↔ workspace `id`** (collision-proof), falling back to
  `tab_title` ↔ `title` only when a UUID is missing.
- **Permission prompts:** `cmux rpc feed.list` returns Feed items including
  `{ kind:"permissionRequest", status:"pending", request_id, title, tool_name,
  cwd }`. Answer with `feed.permission.reply { request_id, mode }`,
  `mode ∈ once|always|all|bypass|deny`. Feed items have no `workspace_id`, so a
  pending request joins to a workspace by **`cwd` ↔ `current_directory`**.
- Targeting (`read-screen` / `send` / `send-key`) accepts the workspace `ref`
  (e.g. `workspace:4`) as `--workspace`.
- **`send-key` naming** is lowercase: `enter`, `escape`, `tab`, `up`, `down`,
  `ctrl+c` (not tmux-style `Return` / `C-c`). Confirmed via `cmux send-key
  --help` and live spot-checks (`escape`/`up` → `OK surface:N workspace:N`).

## The two operational gotchas

- **`CMUX_SOCKET_MODE`** — cmux's socket defaults to rejecting external
  processes. This server is an external process. If calls hang or get refused,
  start cmux in its allow-external socket mode (see the cmux-relay README).
- **Keep-awake** — the dashboard only answers while the laptop is awake and the
  server is running. Use `caffeinate -s` (or lid-closed-on-power keep-awake)
  when you want it reachable away from the desk. (A sleeping laptop mid-edit is
  also what kept killing in-progress work during the build.)

## Security

Binds `0.0.0.0` so the Tailscale hostname routes to it — which means **anything
that can reach the host can drive your sessions.** Keep it on the tailnet only;
do **not** port-forward it to the open internet. Bearer-token auth is a sensible
addition if the tailnet isn't single-user (tracked in `REMAINING.md`).

## Known limitation: terminal is low-color

`cmux read-screen` returns a flattened character snapshot — mostly plain text
plus prompt glyphs, with little to no ANSI color. So the terminal pane renders
**clean but largely monochrome**; this is a property of the data source, not the
converter. Real per-character color requires the live surface stream from cmux's
socket (the same work as live streaming). See `REMAINING.md` → *Live surface
streaming*, which is the single item that unlocks both smooth updates and color.

## Status

| Piece | State |
|---|---|
| Status board (needs-you / active) | ✅ working, real schema |
| Kind-aware badges (done / your turn / needs you) | ✅ working |
| Terminal surface view | ✅ working (clean text; low color — see above) |
| ANSI→HTML + PUA-glyph strip | ✅ working, no external dep |
| Send text / keys | ✅ working (`enter`/`ctrl+c` confirmed; arrows inferred) |
| Approve / Deny (Feed RPC) | ✅ working, verified live (`feed.permission.reply`) |
| Telegram push | ✅ working if creds set; silent no-op otherwise |
| Live streaming surface (+ color) | ❌ not implemented — see `REMAINING.md` |
| Auth / bearer token | ❌ not implemented — tailnet-only |
| Rich status (review / done) | ❌ not implemented — needs-you vs active only |

See **[`REMAINING.md`](./REMAINING.md)** for the full enhancement backlog.
