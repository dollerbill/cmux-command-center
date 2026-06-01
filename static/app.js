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

function ansiToHtml(input) {
  if (!input) return "";
  // Drop non-SGR escape sequences (cursor movement, erase, etc.).
  let t = input.replace(/\x1b\[[0-9;?]*[A-HJKfhlsu]/g, "");
  // Strip Nerd Font / Powerline private-use-area glyphs that the browser
  // can't render (prompt icons, segment separators). These arrive as PUA
  // code points and otherwise show as garbage boxes. read-screen gives a
  // flattened snapshot heavy in these; removing them leaves clean text.
  t = t.replace(/[\uE000-\uF8FF]/g, "")          // BMP private use area
       .replace(/[\u{F0000}-\u{FFFFD}]/gu, "")    // supplementary PUA-A
       .replace(/[\u{100000}-\u{10FFFD}]/gu, ""); // supplementary PUA-B
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

function renderTerm(text) {
  const el = $("#term");
  el.innerHTML = ansiToHtml(text || "");
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

function setApprove(on) {
  const bar = $("#approvebar");
  if (bar) bar.style.display = on ? "flex" : "none";
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
    const { text, pending_approval } = await api(
      `/api/session/${encodeURIComponent(selected)}/screen`);
    renderTerm(text || "(empty surface)");
    setApprove(!!pending_approval);
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
    setTimeout(refreshScreen, 400);
    setTimeout(loadWorkspaces, 400);
  } catch (e) {
    alert(`${act} failed: ${e.message}`);
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
  const keys = [["esc", "Escape"], ["tab", "Tab"], ["\u2191", "Up"], ["\u2193", "Down"],
                ["ctrl-c", "C-c"], ["y", "y"], ["n", "n"], ["\u23ce enter", "Return"]];
  const wrap = $("#keys");
  keys.forEach(([label, key]) => {
    const b = document.createElement("span");
    b.className = "key"; b.textContent = label;
    b.addEventListener("click", () => sendKey(key));
    wrap.appendChild(b);
  });
}

function buildApproveBar() {
  // Inserted just after the terminal; hidden unless a prompt is detected.
  const bar = document.createElement("div");
  bar.id = "approvebar";
  bar.className = "approve";
  bar.style.display = "none";
  bar.innerHTML =
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
