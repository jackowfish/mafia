const $ = (id) => document.getElementById(id);

const store = {
  get(roomId) {
    try {
      return JSON.parse(localStorage.getItem(`mafia:${roomId}`) || "null");
    } catch { return null; }
  },
  set(roomId, data) {
    localStorage.setItem(`mafia:${roomId}`, JSON.stringify(data));
  },
};

let socket = null;
let me = { roomId: null, memberId: null, isHost: false, name: "" };
let latest = null;   // public room state
let priv = null;     // my private state (card, my vote, partners)

// local UI selections, reset when the phase turns over
let voteSel = null;
let renderedPhase = null;
let renderedRound = null;

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

// ── lobby ──────────────────────────────────────────────────────────────────

async function createRoom() {
  const name = $("name").value.trim() || "Host";
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) { $("lobbyErr").textContent = "couldn't open the saloon"; return; }
  const { roomId, hostId, hostToken } = await res.json();
  store.set(roomId, { memberId: hostId, hostToken, name });
  location.hash = roomId;
  enterRoom(roomId, name, { hostToken });
}

function joinRoom(codeOverride) {
  const code = (codeOverride || $("joinCode").value).trim().toUpperCase();
  const name = $("name").value.trim() || (store.get(code)?.name || "");
  if (!code) { $("lobbyErr").textContent = "enter a table code"; return; }
  if (!name) { $("lobbyErr").textContent = "enter your name"; return; }
  location.hash = code;
  enterRoom(code, name, {});
}

function hashCode() {
  return location.hash.length > 1 ? location.hash.slice(1).toUpperCase() : "";
}

function applyHashMode() {
  const code = hashCode();
  if (code) {
    hide($("createBlock"));
    show($("joinBlock"));
    hide($("lobbyTagline"));
    show($("joinBanner"));
    $("joinBannerCode").textContent = code;
    $("joinCode").value = code;
    setTimeout(() => $("name").focus(), 50);
  } else {
    show($("createBlock"));
    hide($("joinBlock"));
    show($("lobbyTagline"));
    hide($("joinBanner"));
  }
}

function enterRoom(roomId, name, { hostToken } = {}) {
  $("lobbyErr").textContent = "";
  const saved = store.get(roomId) || {};
  hostToken = hostToken || saved.hostToken;
  me = { roomId, memberId: null, isHost: false, name: name || saved.name || "Stranger" };

  let firstJoin = true;

  socket = io();

  const doJoin = () => {
    const s2 = store.get(roomId) || {};
    socket.emit(
      "join",
      { roomId, name: me.name, memberId: me.memberId || s2.memberId, hostToken: hostToken || s2.hostToken },
      (resp) => {
        if (resp?.error) {
          if (firstJoin) {
            $("lobbyErr").textContent = resp.error;
            socket.disconnect();
            location.hash = "";
          }
          return;
        }
        me.memberId = resp.memberId;
        me.isHost = !!resp.isHost;
        store.set(roomId, {
          ...(store.get(roomId) || {}),
          memberId: resp.memberId,
          hostToken: hostToken || s2.hostToken,
          name: me.name,
        });

        if (firstJoin) {
          firstJoin = false;
          hide($("lobby"));
          show($("room"));
          $("roomId").textContent = roomId;
          $("youAre").textContent = `you: ${me.name}${me.isHost ? " (mayor)" : ""}`;
          if (me.isHost) show($("settingsBtn"));
        }
      }
    );
  };

  // re-emit join on every (re)connect so the socket gets put back in the
  // room and resumes receiving state broadcasts after a disconnect
  socket.on("connect", doJoin);

  socket.on("state", (s) => { latest = s; render(); });
  socket.on("private", (p) => { priv = p; render(); });
}

// ── helpers ────────────────────────────────────────────────────────────────

function memberById(id) {
  return latest?.members.find((m) => m.id === id) || null;
}
function nameOf(id) {
  return memberById(id)?.name || "someone";
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
const PHASE_LABELS = {
  lobby: "gathering",
  table: "cards out",
  vote: "the vote",
  results: "the tally",
  reveal: "judgment",
};

// ── render ─────────────────────────────────────────────────────────────────

const STAGES = ["stageLobby", "stageTable", "stageVote", "stageResults", "stageReveal"];

function render() {
  if (!latest) return;
  const s = latest;
  const phase = s.phase;
  const inRound = !!memberById(me.memberId)?.inRound;

  // a fresh deal → riffle the deck (not on first paint after a reload)
  if (phase === "table" && renderedRound !== null && s.round !== renderedRound) {
    runShuffle();
  }

  // reset local selections when the phase or round turns over
  if (phase !== renderedPhase || s.round !== renderedRound) {
    voteSel = null;
    renderedPhase = phase;
    renderedRound = s.round;
  }

  // phase banner
  $("phaseLabel").textContent = PHASE_LABELS[phase] || phase;
  $("phaseLabel").dataset.phase = phase;
  const waitBits = [];
  if (s.round > 0) waitBits.push(`round ${s.round}`);
  if (s.mafiaCount > 0) waitBits.push(`${s.mafiaCount} mafia dealt`);
  if (phase === "vote") waitBits.push(`${s.votesIn}/${s.votersTotal} votes in`);
  $("waitLabel").textContent = waitBits.join(" · ");

  // settings
  $("setSheriff").checked = !!s.settings.sheriffEnabled;
  $("setAngel").checked = !!s.settings.angelEnabled;

  // stages
  for (const id of STAGES) hide($(id));
  const stage = {
    lobby: "stageLobby",
    table: "stageTable",
    vote: "stageVote",
    results: "stageResults",
    reveal: "stageReveal",
  }[phase];
  if (stage) show($(stage));

  // my card (the mayor's K♠ for the host, face-down role for everyone else)
  if (phase !== "lobby" && priv?.card) {
    show($("myCardBox"));
    paintCard("cardImg", "cardTitle", priv.card);
  } else {
    hide($("myCardBox"));
  }

  // mafia see their partners
  const notes = [];
  if (inRound && priv?.partners?.length) {
    notes.push(`🔫 Your partner${priv.partners.length === 1 ? "" : "s"} in crime: ${priv.partners.map(nameOf).join(", ")}.`);
  }
  $("privateNote").textContent = notes.join(" ");
  $("privateNote").classList.toggle("hidden", notes.length === 0);

  let ghost = "";
  if (!inRound && !me.isHost && phase !== "lobby") {
    ghost = "you're watching this round from the bar. you'll be dealt in at the next shuffle.";
  }
  $("ghostNote").textContent = ghost;
  $("ghostNote").classList.toggle("hidden", !ghost);

  // per-stage rendering
  if (phase === "lobby") renderLobbyStage(s);
  if (phase === "table") renderTable(s);
  if (phase === "vote") renderVote(s, inRound);
  if (phase === "results") renderResults(s);
  if (phase === "reveal") renderReveal(s);

  renderMembers(s, phase);
}

function renderLobbyStage(s) {
  const players = s.members.length - 1; // the host plays the mayor, not a hand
  const hint = players < s.minPlayers
    ? `${players} player${players === 1 ? "" : "s"} at the table (plus the mayor) - need at least ${s.minPlayers} to deal.`
    : `${players} players at the table. share the link, then deal when everyone's seated.`;
  $("lobbyHint").textContent = hint;
  $("dealRow").classList.toggle("hidden", !me.isHost);
  $("dealBtn").disabled = players < s.minPlayers || players > s.maxPlayers;
  $("dealBtn").textContent = players > s.maxPlayers
    ? `too many players (max ${s.maxPlayers})`
    : "deal the cards";
}

function renderTable(s) {
  $("tableLead").textContent = me.isHost
    ? "cards are out. run the nights out loud and open a vote each day - the game runs until the mafia all hang, or nobody's left to stop them. flip the cards when it's decided."
    : "cards are out. keep yours close - the mayor runs the night from here.";
  $("tableActions").classList.toggle("hidden", !me.isHost);
}

function pickTile(m, selected, disabled) {
  const b = document.createElement("button");
  b.className = "pick-tile" + (selected ? " selected" : "");
  b.disabled = disabled;
  b.setAttribute("role", "option");
  b.setAttribute("aria-selected", selected ? "true" : "false");
  b.innerHTML = `<span class="pick-name">${escapeHtml(m.name)}</span>`;
  return b;
}

function renderVote(s, inRound) {
  const grid = $("voteGrid");
  grid.innerHTML = "";
  const locked = priv?.votedFor !== undefined;

  if (me.isHost) {
    $("votePrompt").textContent = "the town votes. close it when everyone still standing is in.";
    hide($("voteLock")); hide($("voteDone"));
    show($("closeVoteRow"));
    return;
  }
  hide($("closeVoteRow"));

  if (!inRound) { hide($("voteLock")); hide($("voteDone")); $("votePrompt").textContent = ""; return; }

  $("votePrompt").textContent = "point your finger. who hangs?";
  for (const m of s.members) {
    if (!m.inRound || m.id === me.memberId) continue;
    const isSel = locked ? priv.votedFor === m.id : voteSel === m.id;
    const tile = pickTile(m, isSel, locked);
    tile.addEventListener("click", () => { voteSel = m.id; render(); });
    grid.appendChild(tile);
  }
  $("voteLock").classList.toggle("hidden", locked);
  $("voteLock").disabled = !voteSel;
  $("voteDone").classList.toggle("hidden", !locked);
}

function renderTally(s, boxId) {
  const box = $(boxId);
  box.innerHTML = "";
  const t = s.tally;
  if (!t) return;
  const voters = {};
  for (const [voter, target] of Object.entries(t.votes)) {
    (voters[target] = voters[target] || []).push(voter);
  }
  const ranked = Object.keys(t.counts).sort((a, b) => t.counts[b] - t.counts[a]);
  if (ranked.length === 0) {
    box.innerHTML = `<p class="stage-lead">nobody voted. a timid town.</p>`;
    return;
  }
  for (const id of ranked) {
    const row = document.createElement("div");
    row.className = "tally-row" + (t.top.includes(id) ? " top" : "");
    row.innerHTML = `
      <span class="tally-name">${escapeHtml(nameOf(id))}</span>
      <span class="tally-count">${t.counts[id]} vote${t.counts[id] === 1 ? "" : "s"}</span>
      <span class="tally-voters">${(voters[id] || []).map((v) => escapeHtml(nameOf(v))).join(", ")}</span>
    `;
    box.appendChild(row);
  }
}

function renderResults(s) {
  renderTally(s, "tallyBox");
  const t = s.tally;
  let lead = "";
  if (t && t.top.length === 1) lead = `the town points at ${nameOf(t.top[0])}.`;
  else if (t && t.top.length > 1) lead = `dead heat: ${t.top.map(nameOf).join(" and ")}. mayor's call.`;
  $("resultsLead").textContent = lead;
  $("resultsActions").classList.toggle("hidden", !me.isHost);
}

function renderReveal(s) {
  const all = $("allCards");
  all.innerHTML = "";
  for (const [id, card] of Object.entries(s.allCards || {})) {
    const div = document.createElement("div");
    div.className = "mini-card" + (card.role === "mafia" ? " mafia" : "");
    div.innerHTML = `
      <img src="/cards/${card.code}.svg" alt="${card.rank}${card.suit}" draggable="false" />
      <span class="mini-name">${escapeHtml(nameOf(id))}</span>
      <span class="mini-title">${escapeHtml(card.title)}</span>
    `;
    all.appendChild(div);
  }
  $("nextRow").classList.toggle("hidden", !me.isHost);
}

function paintCard(imgId, titleId, card) {
  $(imgId).src = `/cards/${card.code}.svg`;
  $(titleId).textContent = card.title;
  $(titleId).dataset.role = card.role;
}

let shuffleTimer = null;
function runShuffle() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const el = $("shuffleOverlay");
  clearTimeout(shuffleTimer);
  el.classList.remove("hidden", "run");
  void el.offsetWidth; // restart the animation
  el.classList.add("run");
  shuffleTimer = setTimeout(() => el.classList.add("hidden"), 1500);
}

function renderMembers(s, phase) {
  const ul = $("members");
  ul.innerHTML = "";
  for (const m of s.members) {
    const li = document.createElement("li");
    if (phase === "vote" && m.voted && m.inRound) li.classList.add("acted");
    const tags = [];
    if (m.id === me.memberId) tags.push(`<span class="you-tag">you</span>`);
    if (m.isHost) tags.push(`<span class="mayor-tag">🎩 mayor</span>`);
    let status = "";
    if (phase !== "lobby" && !m.inRound && !m.isHost) status = "at the bar";
    else if (phase === "vote" && m.inRound) status = m.voted ? "voted ✓" : "deciding…";
    li.innerHTML = `
      <div class="m-name">${escapeHtml(m.name)} ${tags.join(" ")}</div>
      <div class="m-status">${status}</div>
    `;
    ul.appendChild(li);
  }
}

// ── wire up ────────────────────────────────────────────────────────────────

$("create").addEventListener("click", createRoom);
$("join").addEventListener("click", () => joinRoom());
// typing a table code means you're joining, not hosting
$("joinCode").addEventListener("input", () => {
  $("create").disabled = $("joinCode").value.trim().length > 0;
});
$("joinHash").addEventListener("click", () => joinRoom(hashCode()));
$("backToMain").addEventListener("click", () => {
  history.replaceState(null, "", location.pathname);
  applyHashMode();
});
window.addEventListener("hashchange", applyHashMode);

const emitSimple = (event) => (payload = {}) =>
  socket.emit(event, payload, (r) => { if (r?.error) alert(r.error); });

$("dealBtn").addEventListener("click", () => emitSimple("deal")());
$("redealBtn").addEventListener("click", () => emitSimple("deal")());
$("nextBtn").addEventListener("click", () => emitSimple("deal")());
$("openVoteBtn").addEventListener("click", () => emitSimple("openVote")());
$("openVoteBtn2").addEventListener("click", () => emitSimple("openVote")());
$("closeVoteBtn").addEventListener("click", () => emitSimple("closeVote")());
$("revealBtn").addEventListener("click", () => emitSimple("reveal")());
$("revealBtn2").addEventListener("click", () => emitSimple("reveal")());

$("voteLock").addEventListener("click", () => {
  if (!voteSel) return;
  emitSimple("vote")({ targetId: voteSel });
});

// hold-to-peek on your card - the role text only shows while held,
// so a glance at someone else's idle screen gives nothing away
const myCard = $("myCard");
const peek = (on) => {
  myCard.classList.toggle("peek", on);
  $("cardBlurbSlot").textContent =
    on && priv?.card ? priv.card.blurb : "keep it close to your chest";
};
myCard.addEventListener("pointerdown", (e) => { e.preventDefault(); peek(true); });
for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
  myCard.addEventListener(ev, () => peek(false));
}
myCard.addEventListener("contextmenu", (e) => e.preventDefault());
myCard.addEventListener("keydown", (e) => {
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); peek(true); }
});
myCard.addEventListener("keyup", (e) => {
  if (e.key === " " || e.key === "Enter") peek(false);
});

// settings modal
function openSettings() {
  $("settingsModal").classList.remove("hidden");
  $("settingsModal").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}
function closeSettings() {
  $("settingsModal").classList.add("hidden");
  $("settingsModal").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}
$("settingsBtn").addEventListener("click", openSettings);
$("settingsModal").addEventListener("click", (e) => {
  if (e.target.matches("[data-close]")) closeSettings();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("settingsModal").classList.contains("hidden")) closeSettings();
});

function emitSettings() {
  socket.emit("settings", {
    settings: {
      sheriffEnabled: $("setSheriff").checked,
      angelEnabled: $("setAngel").checked,
    },
  });
}
for (const id of ["setSheriff", "setAngel"]) {
  $(id).addEventListener("change", emitSettings);
}

$("copyLink").addEventListener("click", async () => {
  const url = `${location.origin}/#${me.roomId}`;
  try {
    await navigator.clipboard.writeText(url);
    $("copyLink").textContent = "copied";
    setTimeout(() => ($("copyLink").textContent = "copy link"), 1500);
  } catch {}
});

applyHashMode();
