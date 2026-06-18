# REMAINING — cmux command center

Enhancement backlog and known limitations. Ordered roughly by value-to-effort.
Each item has enough context to be picked up cold.

**Status (2026-06-01):** P1 fully resolved (send-key naming verified incl. live
key spot-checks + Approve/Deny rewritten onto cmux's Feed RPC, verified live).
P4 title-collision resolved (UUID join). Approve/Deny hardened — see *Approve/Deny
robustness* below (cwd-join skew + ghost-bar fixed). Outstanding: P4 notify-poll
de-dup (a real bug, parked until Telegram lands), then P2 (launchd) → P3
(streaming) etc.

---

## ✅ RESOLVED (2026-06-01) — Approve/Deny robustness (two field-reported bugs)

Both traced to one design flaw: the approve bar's **visibility** and the approve
**action** were driven by *different* signals, free to disagree.

1. **Approve did nothing remotely (dead button).** The action joined a pending
   Feed `permissionRequest` to the workspace by raw `cwd == current_directory`,
   which silently misses on trailing-slash / macOS symlink skew (`/tmp` →
   `/private/tmp`) or when the agent `cd`'d into a subdir — while the bar still
   showed via the `detect_approval` screen-scrape fallback. Keys worked (they
   target `--workspace ref`, no cwd), so the symptom was "only Approve is dead."
   Fixed in `cmux.pending_permission` (`app/cmux.py`): normalize paths
   (`_norm_path` → realpath + strip trailing slash), then match exact →
   subdirectory-prefix → single-pending fallback. No app-side approval TTL exists,
   so "sat for minutes" was a red herring — it was the join, not a timeout.

2. **Bar lingered after host-approve (ghost button).** Visibility was
   `bool(feed_pending) OR detect_approval(text)`; `read-screen` returns a
   flattened snapshot whose `1. Yes / 2. No` text persists after the prompt
   resolves, so the heuristic re-raised the bar every poll. Fixed in the `/screen`
   route (`app/main.py`): when the Feed is reachable it is authoritative
   (`feed_authoritative`), and the screen heuristic is used **only** as a fallback
   when the Feed can't be consulted. (The ~0–2s `POLL_SCREEN` latency is inherent
   to polling and unchanged; P3's `events.stream` would remove it.)

Verified with a no-cmux unit harness monkeypatching `cmux.rpc` over all join
paths (exact / trailing-slash / subdir / single-pending / ambiguous→None /
newest-wins / no-pending→None / unresolved-cwd). Live re-verification against real
cmux still pending (cmux isn't on PATH outside a pane).

---

## P1 — Verify on real data (cheap, do first)

### ✅ RESOLVED — `send-key` key naming
Confirmed via `cmux send-key --help` and live spot-checks: keys are **lowercase**
(`enter`, `escape`, `tab`, `up`, `down`, `ctrl+c`), NOT tmux-style (`Return`,
`C-c`). `escape` and `up` were verified live (`OK surface:8 workspace:1`).
Fixed in `app/cmux.py`, `app/main.py` (×3), and `static/app.js` (key bar).

### ✅ RESOLVED — Approve/Deny (rewritten onto the Feed RPC, verified live)
Discovered cmux exposes a structured Feed: `cmux rpc feed.list` returns
`{ kind:"permissionRequest", status:"pending", request_id, title, tool_name,
cwd }` items, answered by `feed.permission.reply { request_id, mode }` with
`mode ∈ once|always|all|bypass|deny`.

Replaced the brittle screen-scrape + `send "1"/"3"` approach entirely:
- Detection: `cmux.pending_permission(cwd)` finds the pending request (joined to
  the workspace by `cwd == current_directory`; Feed items carry no workspace_id).
- Reply: `cmux.reply_permission(request_id, approve)` → `mode:once` (approve this
  action) / `mode:deny`. `detect_approval` kept only as a degraded fallback.
- The detail-pane bar now shows *what* is being approved ("Allow Bash?").

**Verified live** against real cmux: a pending request flips `pending→resolved`
on reply (`{delivered:true}`); the cwd-join selects the correct (newest) request;
`/screen`, `/approve`, `/deny` routes return the right shapes. `always` mode
(approve-and-remember) is available for free as a future enhancement.

---

## P2 — Daemonize as a launchd service (do after P1)

**Problem:** the server only runs while `./run.sh` is going in a terminal. A
remote dashboard you can't reach because you closed the terminal (or the laptop
logged out) defeats the purpose.

**Fix:** a macOS `launchd` LaunchAgent (`~/Library/LaunchAgents/com.cropley.
cmux-cc.plist`) that runs `run.sh` at login and respawns it if it dies
(`KeepAlive`). `launchctl load/unload` to control it. ~20-line plist, no rewrite.
Points `ProgramArguments` at the venv's uvicorn (or at `run.sh`), sets
`RunAtLoad` + `KeepAlive`, and redirects `StandardOutPath`/`StandardErrorPath`
to a log file for debugging.

**Why after P1:** don't auto-restart behavior that isn't verified yet — confirm
send-key and approve/deny first, then make it always-on.

**Pairs with:** the keep-awake note in the README (`caffeinate`). launchd keeps
the *server* alive; caffeinate keeps the *laptop reachable*. Both needed for
true always-on remote access. A sleeping laptop still can't be reached even with
the service running.

**Explicitly NOT a Swift menubar app.** Wrapping the server in a Swift app to
manage its lifecycle duplicates what launchd does natively, for the cost of a
whole toolchain. Only consider a small menubar *helper* later if you want native
macOS affordances (status menu, native notifications) — and even then it should
talk to the launchd-managed server, not embed it. The web-app-over-tailnet shape
is the correct long-term architecture for cross-device reach (it's what beat
Cmux Remote on iPad); don't retreat to native-macOS-only. "App-first" belongs on
the frontend (see PWA under Ideas), not as a native wrapper.

---

## P3 — Live surface streaming (the big one; unlocks color too)

**Problem:** the terminal pane polls `cmux read-screen`, which returns a
flattened snapshot — choppy updates and almost no ANSI color. This is the single
limitation behind both "not smooth" and "not colorful."

**Fix:** stream the real surface over cmux's Unix socket instead of polling.
The cmux-relay source (`NewTurn2017/cmux-remote`) already does exactly this —
speaks the socket, streams the live surface, sends keystrokes. Two options:
- Crib the relay's socket approach into a WebSocket bridge in this server, push
  frames to the browser, render with a real terminal emulator (xterm.js).
- Or point the front-end at the relay protocol directly and keep this server
  for the status/board/API layer only.

**Payoff:** true per-character color, smooth live updates, proper TUI rendering
(lazygit, etc.). **Cost:** real work — socket client + WebSocket + xterm.js.
Biggest single upgrade available. Until done, the terminal stays clean-but-
low-color by design (documented in README).

**Discovery (from the P1 capability dump):** cmux exposes a native event stream
— `cmux events [--after <seq>] [--name <event>] [--reconnect]` and the
`events.stream` RPC. This is a polling-free push source for *board/status*
updates (notifications, session start/stop), and could replace the 3s notify
poll regardless of whether the terminal surface streaming gets built. Cheaper
half of P3 if the full xterm.js surface stream is deferred.

---

## P4 — Security & robustness (before any non-solo use)

### Bearer-token auth
Server binds `0.0.0.0`; anything on the tailnet can drive sessions. Fine for a
single-user tailnet, not for shared. Add a token check (env var → header) on the
mutating routes (`send`, `key`, `approve`, `deny`) at minimum. Tracked because
the moment another person/device joins the tailnet, this matters.

### Harden the notify poll de-dup  — STILL A BUG (do when Telegram lands)
`_poll_loop` (`app/main.py`) keys seen notifications on `n.get('workspace')` |
`n.get('message')` — **neither field exists** on a cmux notification (the real
fields are `tab_title`/`subtitle`/`body` + a unique `id`). So every key is
`"None|None"` and only the first notification ever pushes; `notify.py` reads the
same non-existent fields. Switch the de-dup key to the notification **`id`** (and
fix `notify_pending` to read `tab_title`/`subtitle`/`body`). Untouched so far
because Telegram isn't integrated yet — fix it alongside that work. (Quick.)

### ✅ RESOLVED — Title-collision fragility
Was thought unfixable ("no better key is exposed by cmux"). It is fixable:
`list-workspaces --json --id-format both` exposes each workspace's stable UUID
as `id`, which matches the notification's `workspace_id`. The join now uses that
UUID (`app/cmux.py::_apply_notifications`), with `tab_title==title` as a fallback
only. Collision-proof; verified live (routes correctly even with a wrong title).

---

## P5 — Richer status model

Currently only *needs-you* vs *active*. Add a per-session markdown convention
(from the orchestrator pattern): `goal / status / progress / definition-of-done`,
one file per workspace. Read them server-side (we already have each workspace's
`cwd`) and merge into workspace status so the board can show *blocked /
in-progress / review / done*. This is also the dashboard layer that syncs to
Obsidian on mobile — the async overview surface alongside this control surface.

**Discovery (from the P1 capability dump):** the premise "cmux alone doesn't
expose review/done" is partly outdated. cmux has native, scriptable status:
- `set-status <key> <value> [--icon --color --priority]` / `list-status` /
  `clear-status` — arbitrary per-workspace status chips, readable back.
- `set-progress <0.0-1.0> [--label]` / `clear-progress` — a progress bar.
- The Feed also surfaces `question` items (`feed.list` → `kind:"question"` with
  `question_prompt` / `question_options[{id,label,description}]` /
  `question_multi_select`, answered via `feed.question.reply`). So the dashboard
  could render *real* multiple-choice agent questions, not just yes/no — a
  natural sibling to the Feed-based approve/deny already built in P1.
Decide whether to lean on cmux-native status (set-status/progress, no extra
files) or the markdown convention (portable, Obsidian-syncable) — or both.

---

## P6 — Nicer terminal / glyphs

### ✅ RESOLVED (2026-06-05) — readability via structural color hierarchy
The "giant wall of same-color text" was the flattened `read-screen` snapshot
carrying almost no ANSI color. Rather than wait on streaming, the front-end now
classifies each line by its transcript role (`lineClass` in `static/app.js`) and
colors it: tool calls (accent) and output (dim) recede, assistant messages,
permission prompts (warn), the selected option, and your own input stand out.
High-precision rules only — unmatched lines stay default, so markdown `-`/`+`
lines are never miscolored as diffs (verified). This does **not** add true
per-character color (still needs P3 streaming below); it recovers a reading
hierarchy from the monochrome data we already have.

- **Nerd Font prompt glyphs** (`±`, branch icons, P10k separators) are currently
  *stripped* (PUA code points removed) so they don't show as garbage. If you
  ever want them rendered properly, subset a Nerd Font to just the PUA glyphs
  you use and `@font-face` it locally (don't ship a multi-MB font). Bounded but
  real; low priority — they're decorative prompt chrome, not Claude output.
- **256-color / truecolor** (`38;5;n`, `38;2;r;g;b`) are ignored by the
  hand-rolled converter (only the standard 16 colors map). Mostly moot once P3
  (xterm.js) lands, which handles these natively. Only worth a converter
  extension if P3 is deferred indefinitely.

---

## P7 — Telegram, leveled up

Push currently sends a one-way "needs you" message. Upgrade to **actionable**:
inline Approve/Deny buttons in the Telegram message that call back to the
server's approve/deny routes. Turns the phone into a true remote control without
even opening the dashboard. Natural to build alongside the post-June-15 Hermes
work, since both lean on the same Telegram pipe.

---

## Ideas / maybe

- **PWA + web push** as an alternative/supplement to Telegram for "needs you"
  alerts (iOS 16.4+ supports web push once added to home screen; finicky).
- **Vendor nothing / add nothing** — keep the zero-dependency front-end ethos;
  the ANSI converter being hand-rolled (vs the ansi_up CDN that 404'd and ships
  as an ES module) is deliberate and worth preserving.
- **Multi-window cmux** — `list-workspaces` returns a `window_ref`; this v1
  assumes a single window. If you run multiple cmux windows, group by window.
