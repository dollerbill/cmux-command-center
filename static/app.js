// cmux command center — front-end logic.
// Talks to the FastAPI backend; falls back to DEMO data if the API isn't
// reachable so the page is still inspectable (the pill shows live/demo).
//
// Approve/Deny is NOT shown on cards. A notification means "this workspace
// wants you", but that covers "completed" and "your turn (Waiting)" too, which
// are not approvable. Approve/Deny appears ONLY in the detail pane, and ONLY
// when the selected session's screen actually shows a permission prompt
// (server returns pending_approval from detect_approval()).

const $ = (s, r = document) => r.querySelector(s);

// ---- self-contained ANSI -> HTML (no external dependency) ----------------
// Handles SGR color/style codes (the colorful part of terminal output) and
// strips other escape sequences (cursor moves, clears) that would otherwise
// render as garbage. Enough for Claude Code's output; not a full terminal
// emulator. Standard 16-color palette on a dark background.
const ANSI_FG = {
  30:"#3b4252",31:"#ff6b6b",32:"#3fce7c",33:"#ffb44d",34:"#5aa2ff",
  35:"#c08cff",36:"#42c9d4",37:"#d4deea",90:"#647183",91:"#ff8787",
  92:"#69e2a0",93:"#ffce85",94:"#85bcff",95:"#d4adff",96:"#7adbe4",97:"#ffffff"
};
const ANSI_BG = {
  40:"#04070d",41:"#ff6b6b",42:"#3fce7c",43:"#ffb44d",44:"#5aa2ff",
  45:"#c08cff",46:"#42c9d4",47:"#d4deea"
};
const escHtml = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

// Drop non-SGR escapes (cursor moves, erase) and unrenderable Nerd Font /
// Powerline private-use-area glyphs. read-screen's flattened snapshot is heavy
// in these; removing them leaves clean text. Shared by the ANSI converter and
// the structural classifier so both see the same characters.
function stripChrome(t) {
  return t.replace(/\x1b\[[0-9;?]*[A-HJKfhlsu]/g, "")
          .replace(/[\uE000-\uF8FF]/g, "")
          .replace(/[\u{F0000}-\u{FFFFD}]/gu, "")
          .replace(/[\u{100000}-\u{10FFFD}]/gu, "");
}

function ansiToHtml(input) {
  if (!input) return "";
  const t = stripChrome(input);
  // Split on SGR color sequences, keeping the codes.
  const parts = t.split(/\x1b\[([0-9;]*)m/);
  let out = "", open = false;
  let style = { fg: null, bg: null, bold: false, dim: false };
  const span = () => {
    const css = [];
    if (style.fg) css.push(`color:${style.fg}`);
    if (style.bg) css.push(`background:${style.bg}`);
    if (style.bold) css.push("font-weight:700");
    if (style.dim) css.push("opacity:.65");
    return css.length ? `<span style="${css.join(";")}">` : "<span>";
  };
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) {
        if (open) out += "</span>";
        out += span() + escHtml(parts[i]) + "</span>";
        open = false;
      }
    } else {
      const codes = parts[i].split(";").filter(Boolean).map(Number);
      if (codes.length === 0) codes.push(0);
      for (const c of codes) {
        if (c === 0) style = { fg:null, bg:null, bold:false, dim:false };
        else if (c === 1) style.bold = true;
        else if (c === 2) style.dim = true;
        else if (c === 22) { style.bold = false; style.dim = false; }
        else if (ANSI_FG[c]) style.fg = ANSI_FG[c];
        else if (ANSI_BG[c]) style.bg = ANSI_BG[c];
        else if (c === 39) style.fg = null;
        else if (c === 49) style.bg = null;
      }
    }
  }
  return out;
}

// read-screen returns a flat, near-monochrome snapshot, so we recover a reading
// hierarchy structurally: classify each line by its role in a Claude Code
// transcript and color it, then run inline ANSI within the line (per-line so an
// SGR span can't straddle a line boundary). High-precision rules only — when a
// line doesn't clearly match, it stays default rather than risk miscoloring.
function lineClass(line) {
  const t = stripChrome(line).replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
  if (!t.trim()) return "";
  if (/want to proceed\??/i.test(t)) return "ln-prompt";
  if (/^\s*[❯>]?\s*\d+\.\s+(yes|no)\b/i.test(t))
    return /^\s*❯/.test(t) ? "ln-option ln-sel" : "ln-option";
  if (/^\s*[●⏺]\s+[A-Z][\w.-]*\(/.test(t)) return "ln-tool";   // ● Bash(…)
  if (/^\s*[●⏺]\s/.test(t)) return "ln-assistant";             // ● message
  if (/^\s*[⎿└├]/.test(t)) return "ln-result";           // ⎿ tool output
  if (/^\s*>\s/.test(t)) return "ln-user";                               // > your input
  if (/^[\s─-╿]+$/.test(t)) return "ln-chrome";                // box/sep rules
  return "";
}

function renderTerm(text) {
  const el = $("#term");
  el.innerHTML = (text || "").split("\n").map(line => {
    const cls = lineClass(line);
    const inner = ansiToHtml(line);
    return cls ? `<span class="${cls}">${inner}</span>` : inner;
  }).join("\n");
  el.scrollTop = el.scrollHeight;
}

let selected = null;
let screenTimer = null;
let demo = false;

const POLL_LIST = 4000;
const POLL_SCREEN = 2000;

const DEMO = {
  needs_you: [
    { id: "workspace:4", name: "\u{1F41B} auth-bug", cwd: "canvas-dx-rails", ports: ["3000"], needs_attention: true, attention_kind: "other", last_line: "Run the test migration to verify the fix?" },
    { id: "workspace:9", name: "\u{1F4E6} deps-bump", cwd: "~/Projects/api", ports: [], needs_attention: true, attention_kind: "completed", last_line: "Done \u2014 14 files changed." },
    { id: "workspace:7", name: "\u{1F52C} research", cwd: "~/research", ports: [], needs_attention: true, attention_kind: "waiting", last_line: "Which competitors should I prioritize?" }
  ],
  active: [
    { id: "workspace:1", name: "\u{1F4F1} hotwire-native", cwd: "canvas-dx-rails", ports: ["3000"], needs_attention: false, last_line: "Wiring the iOS path config\u2026" },
    { id: "workspace:2", name: "\u{1F916} ai-assistant", cwd: "~/Projects/ai-assistant", ports: [], needs_attention: false, last_line: "Refactoring the model call\u2026" }
  ]
};

const DEMO_SCREEN_PROMPT = `\u25cf I need to run the migration on the test DB to verify:

  Bash(rails db:migrate RAILS_ENV=test)
  Do you want to proceed?
  \u276f 1. Yes   2. Yes, and don't ask again   3. No`;

const DEMO_SCREEN_PLAIN = `\u25cf Sounds good \u2014 I'll hold off on the invoice until I hear back.

(waiting for your next message)`;

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

function setConn(ok) {
  $("#conn").innerHTML = ok
    ? '<span class="dot ok"></span> live'
    : '<span class="dot bad"></span> demo';
  $("#note").textContent = ok
    ? "live \u2014 wired to cmux via the local CLI"
    : "demo data \u2014 cmux API not reachable. Start this server next to cmux, or check CMUX_SOCKET_MODE.";
}

function metaLine(w) {
  return [w.cwd, w.branch, w.pr ? "PR #" + w.pr : null,
          ...(w.ports || []).map(p => ":" + p)].filter(Boolean).join("  \u00b7  ");
}

function badge(w) {
  if (!w.needs_attention) return "";
  const k = w.attention_kind;
  const cls = k === "waiting" ? "k-waiting"
            : k === "completed" ? "k-completed"
            : "k-needs";
  const label = k === "waiting" ? "your turn"
              : k === "completed" ? "done"
              : "needs you";
  return `<span class="badge ${cls}">${label}</span>`;
}

function card(w) {
  const div = document.createElement("div");
  div.className = "card" + (w.needs_attention ? " attn" : "")
                + (selected === w.id ? " sel" : "");
  div.innerHTML =
    `<div class="crow"><span class="cname">${esc(w.name)}</span>${badge(w)}</div>` +
    `<div class="cmeta">${esc(metaLine(w))}</div>` +
    (w.last_line ? `<div class="clast">${esc(w.last_line)}</div>` : "");
  // No approve/deny on cards — click opens the session.
  div.addEventListener("click", () => select(w));
  return div;
}

function render(groups) {
  const list = $("#list");
  list.innerHTML = "";
  const sections = [["needs_you", "\u26a0 Needs you"], ["active", "\u25b6 Active"]];
  let needs = 0;
  for (const [key, label] of sections) {
    const items = groups[key] || [];
    if (key === "needs_you") needs = items.length;
    if (!items.length) continue;
    const g = document.createElement("div");
    g.className = "group";
    const head = document.createElement("div");
    head.className = "ghead";
    head.innerHTML = `${label}<span class="gcount">${items.length}</span>`;
    g.appendChild(head);
    items.forEach(w => g.appendChild(card(w)));
    list.appendChild(g);
  }
  const total = (groups.needs_you || []).length + (groups.active || []).length;
  $("#counts").textContent = `${total} workspaces` + (needs ? ` \u00b7 \u26a0 ${needs}` : "");
}

async function loadWorkspaces() {
  try {
    const groups = await api("/api/workspaces");
    demo = false; setConn(true); render(groups);
  } catch (e) {
    demo = true; setConn(false); render(DEMO);
  }
}

function select(w) {
  selected = w.id;
  $("#d-name").textContent = w.name;
  $("#d-badge").innerHTML = w.needs_attention ? badge(w) : "";
  $("#target").textContent = `\u2192 cmux send --workspace "${w.id}"`;
  document.querySelectorAll(".card").forEach(c => c.classList.remove("sel"));
  setApprove(false);
  refreshScreen();
  if (screenTimer) clearInterval(screenTimer);
  screenTimer = setInterval(refreshScreen, POLL_SCREEN);
}

function setApprove(on, pending) {
  const bar = $("#approvebar");
  if (!bar) return;
  bar.style.display = on ? "flex" : "none";
  const lbl = $("#apprWhat");
  if (lbl) {
    // Show WHAT is being approved when the server resolved it from the Feed
    // (e.g. "Run Bash?"). Falls back to a generic label for the screen-scrape
    // heuristic, which knows a prompt exists but not its tool.
    const tool = pending && (pending.title || pending.tool_name);
    lbl.textContent = tool ? `Allow ${tool}?` : "Permission requested";
  }
}

async function refreshScreen() {
  if (!selected) return;
  if (demo) {
    const prompt = selected === "workspace:4";
    renderTerm(prompt ? DEMO_SCREEN_PROMPT : DEMO_SCREEN_PLAIN);
    setApprove(prompt);
    return;
  }
  try {
    const { text, pending_approval, pending } = await api(
      `/api/session/${encodeURIComponent(selected)}/screen`);
    renderTerm(text || "(empty surface)");
    setApprove(!!pending_approval, pending);
  } catch (e) {
    renderTerm("(could not read surface: " + e.message + ")");
    setApprove(false);
  }
}

async function approveSelected(act) {
  if (!selected) return;
  if (demo) { alert(`demo: would ${act} the prompt`); return; }
  try {
    await api(`/api/session/${encodeURIComponent(selected)}/${act}`, { method: "POST" });
    setApprove(false);  // optimistic: hide the bar; the poll re-shows it if still pending
    setTimeout(refreshScreen, 400);
    setTimeout(loadWorkspaces, 400);
  } catch (e) {
    // 409 = the prompt was already answered/expired by the time we replied.
    const msg = /409|no pending/i.test(e.message)
      ? "That prompt is no longer pending (already answered or expired)."
      : `${act} failed: ${e.message}`;
    alert(msg);
    refreshScreen();
  }
}

async function sendText() {
  const inp = $("#cmdin");
  const v = inp.value.trim();
  if (!v || !selected) return;
  if (demo) { $("#term").textContent += `\n\n\u276f ${v}`; inp.value = ""; return; }
  try {
    await api(`/api/session/${encodeURIComponent(selected)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: v, enter: true })
    });
    inp.value = "";
    setTimeout(refreshScreen, 300);
  } catch (e) { alert("send failed: " + e.message); }
}

async function sendKey(key) {
  if (!selected) return;
  if (demo) { $("#cmdin").focus(); return; }
  try {
    await api(`/api/session/${encodeURIComponent(selected)}/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key })
    });
    setTimeout(refreshScreen, 300);
  } catch (e) { alert("key failed: " + e.message); }
}

function buildKeys() {
  // cmux key names are lowercase: `enter`, `escape`, `tab`, arrows, chords like
  // `ctrl+c` (verified via `cmux send-key --help`). NOT tmux-style Return/C-c.
  const keys = [["esc", "escape"], ["tab", "tab"], ["\u2191", "up"], ["\u2193", "down"],
                ["ctrl-c", "ctrl+c"], ["y", "y"], ["n", "n"], ["\u23ce enter", "enter"]];
  const wrap = $("#keys");
  keys.forEach(([label, key]) => {
    const b = document.createElement("span");
    b.className = "key"; b.textContent = label;
    b.addEventListener("click", () => sendKey(key));
    wrap.appendChild(b);
  });
  // Claude Code's permission mode (normal / accept-edits / plan) is cycled with
  // Shift+Tab in its TUI — it's a keystroke to the pane, not a cmux concept. One
  // button cycles; you can't jump to a specific mode. Some terminals deliver
  // Shift+Tab as the backtab escape \x1b[Z, so if `shift+tab` doesn't register
  // we fall back to sending that raw sequence.
  const mode = document.createElement("span");
  mode.className = "key key-mode"; mode.textContent = "⇧⇥ mode";
  mode.title = "Cycle Claude Code mode (normal → accept edits → plan)";
  mode.addEventListener("click", () => sendKey("shift+tab"));
  wrap.appendChild(mode);
}

function buildApproveBar() {
  // Inserted just after the terminal; hidden unless a prompt is detected.
  const bar = document.createElement("div");
  bar.id = "approvebar";
  bar.className = "approve";
  bar.style.display = "none";
  bar.innerHTML =
    `<span id="apprWhat" class="approve-what"></span>` +
    `<button class="btn btn-y" id="apprY">\u2713 Approve</button>` +
    `<button class="btn btn-n" id="apprN">\u2715 Deny</button>`;
  $("#term").insertAdjacentElement("afterend", bar);
  $("#apprY").addEventListener("click", () => approveSelected("approve"));
  $("#apprN").addEventListener("click", () => approveSelected("deny"));
}

function init() {
  buildKeys();
  buildApproveBar();
  $("#sendbtn").addEventListener("click", sendText);
  $("#cmdin").addEventListener("keydown", e => { if (e.key === "Enter") sendText(); });
  loadWorkspaces();
  setInterval(loadWorkspaces, POLL_LIST);
}

init();
