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
let priv = null;     // my private state (card, picks, partners; every hand for the mayor)

// local UI selections, reset when the phase turns over
let nomSel = [];
let renderedPhase = null;
let renderedRound = null;

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

// ── lobby ──────────────────────────────────────────────────────────────────

async function createRoom() {
  if ($("joinCode").value.trim()) return; // a code in the field means you're joining
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

// one lobby screen for everything: a shared link just prefills the code
function applyHashMode() {
  const code = hashCode();
  if (code) {
    hide($("lobbyTagline"));
    show($("joinBanner"));
    $("joinBannerCode").textContent = code;
    $("joinCode").value = code;
    setTimeout(() => $("name").focus(), 50);
  } else {
    show($("lobbyTagline"));
    hide($("joinBanner"));
  }
  syncCreate();
}

function exitToLobby(msg = "") {
  try { socket?.disconnect(); } catch {}
  socket = null;
  latest = null;
  priv = null;
  renderedPhase = null;
  renderedRound = null;
  me = { roomId: null, memberId: null, isHost: false, name: me.name };
  hide($("room"));
  hide($("settingsBtn"));
  hide($("renameBtn"));
  show($("lobby"));
  $("lobbyErr").textContent = msg;
  $("joinCode").value = "";
  history.replaceState(null, "", location.pathname);
  applyHashMode();
}

function enterRoom(roomId, name, { hostToken } = {}) {
  $("lobbyErr").textContent = "";
  const saved = store.get(roomId) || {};
  hostToken = hostToken || saved.hostToken;
  me = { roomId, memberId: null, isHost: false, name: name || saved.name || "Stranger" };

  let firstJoin = true;

  socket = io();

  socket.on("kicked", () => {
    // the seat is gone - forget it so a rejoin starts fresh
    store.set(roomId, { name: (store.get(roomId) || {}).name });
    exitToLobby("the mayor showed you the door.");
  });

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
        }
      }
    );
  };

  // re-emit join on every (re)connect so the socket gets put back in the
  // room and resumes receiving state broadcasts after a disconnect
  socket.on("connect", doJoin);
  rejoin = doJoin;

  socket.on("state", (s) => { latest = s; render(); });
  socket.on("private", (p) => { priv = p; render(); });
}

let rejoin = null; // re-emits join on the live socket (used after a rename)

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
  nominating: "nominations",
  runoff: "runoff",
  trial: "the trial",
  verdict: "the vote",
  results: "judgment",
  reveal: "cards up",
};

// ── render ─────────────────────────────────────────────────────────────────

const STAGES = ["stageLobby", "stageTable", "stageNoms", "stageTrial", "stageResults", "stageReveal"];

function render() {
  if (!latest) return;
  const s = latest;
  const phase = s.phase;
  const myself = memberById(me.memberId);
  const inRound = !!myself?.inRound;
  const alive = inRound && myself.alive;

  // a fresh deal → riffle the deck (not on first paint after a reload)
  if (phase === "table" && renderedRound !== null && s.round !== renderedRound) {
    runShuffle();
  }

  // reset local selections when the phase or round turns over
  if (phase !== renderedPhase || s.round !== renderedRound) {
    nomSel = [];
    renderedPhase = phase;
    renderedRound = s.round;
  }

  // phase banner
  $("phaseLabel").textContent = PHASE_LABELS[phase] || phase;
  $("phaseLabel").dataset.phase = phase;
  const waitBits = [];
  if (s.round > 0) waitBits.push(`round ${s.round}`);
  if (s.mafiaCount > 0) waitBits.push(`${s.mafiaCount} mafia dealt`);
  if (phase === "nominating") waitBits.push(`${s.nomsIn}/${s.nomsTotal} accusations in`);
  if (phase === "runoff") waitBits.push(`${s.runoff.picksIn}/${s.runoff.picksTotal} runoff picks in`);
  if (phase === "verdict") waitBits.push(`${s.votesIn}/${s.votersTotal} votes in`);
  $("waitLabel").textContent = waitBits.join(" · ");

  // settings
  $("setSheriff").checked = !!s.settings.sheriffEnabled;
  $("setAngel").checked = !!s.settings.angelEnabled;

  // lobby-only controls: renames, house rules, and dropping players all
  // settle once the first hand is dealt
  $("renameBtn").classList.toggle("hidden", phase !== "lobby");
  $("settingsBtn").classList.toggle("hidden", !(me.isHost && phase === "lobby"));
  if (phase !== "lobby" && !$("settingsModal").classList.contains("hidden")) closeSettings();

  // stages
  for (const id of STAGES) hide($(id));
  const stage = {
    lobby: "stageLobby",
    table: "stageTable",
    nominating: "stageNoms",
    runoff: "stageNoms",
    trial: "stageTrial",
    verdict: "stageTrial",
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

  // the game calls itself when the cards decide it
  if (s.winner) {
    $("winnerText").textContent = s.winner === "town"
      ? "☀️ every last mafia is in the ground. the town wins."
      : "🔫 the mafia has the town outnumbered. nothing left to stop them - mafia wins.";
    $("winnerActions").classList.toggle("hidden", !me.isHost || phase === "reveal");
    show($("winnerBox"));
  } else {
    hide($("winnerBox"));
  }

  // mafia see their partners; the mayor hears when the angel holds the line
  const notes = [];
  if (inRound && priv?.partners?.length) {
    notes.push(`🔫 Your partner${priv.partners.length === 1 ? "" : "s"} in crime: ${priv.partners.map(nameOf).join(", ")}.`);
  }
  if (me.isHost && priv?.mayorNote) notes.push(`🎩 ${priv.mayorNote}`);
  $("privateNote").textContent = notes.join(" ");
  $("privateNote").classList.toggle("hidden", notes.length === 0);

  // the mayor's ledger: every hand, for their eyes only
  if (me.isHost && priv?.allCards && phase !== "lobby") {
    renderLedger(priv.allCards);
    show($("ledgerBox"));
  } else {
    hide($("ledgerBox"));
  }

  let ghost = "";
  if (!inRound && !me.isHost && phase !== "lobby") {
    ghost = "you're watching this round from the bar. you'll be dealt in at the next shuffle.";
  } else if (inRound && !alive) {
    ghost = "☠ you're dead. enjoy the show - no pointing, no voting.";
  }
  $("ghostNote").textContent = ghost;
  $("ghostNote").classList.toggle("hidden", !ghost);

  // per-stage rendering
  if (phase === "lobby") renderLobbyStage(s);
  if (phase === "table") renderTable(s);
  if (phase === "nominating" || phase === "runoff") renderNoms(s, alive, phase);
  if (phase === "trial" || phase === "verdict") renderTrial(s, alive, phase);
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
    ? "cards are out. run the nights out loud - when the town wants blood, open nominations. the game runs until the mafia all hang, or nobody's left to stop them."
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

function renderNoms(s, alive, phase) {
  const runoff = phase === "runoff";
  const seats = runoff ? s.runoff.seats : 2;
  const pool = s.members.filter((m) =>
    runoff ? s.runoff.candidates.includes(m.id) : m.inRound && m.alive
  );
  // narrowed runoffs shrink the pool - drop any stale selections
  nomSel = nomSel.filter((id) => pool.some((m) => m.id === id)).slice(0, seats);

  if (runoff) {
    $("nomHead").textContent = s.runoff.attempt > 1 ? "still deadlocked" : "dead heat for the gallows";
    $("nomPrompt").innerHTML =
      (s.runoff.attempt > 1 ? "nobody budged. " : "") +
      `${s.runoff.candidates.length} tied for ${seats === 1 ? "the last poster" : "the posters"}. ` +
      `point <b>${seats === 1 ? "one finger" : "two fingers"}</b> - among the tied only.` +
      (s.runoff.attempt > 1 ? " tie again and the deck decides." : "");
  } else {
    $("nomHead").textContent = "point two fingers";
    $("nomPrompt").innerHTML = "nominate <b>two</b> players you don't trust. the two most-accused stand trial.";
  }
  $("closeNomsBtn").textContent = runoff ? "close the runoff" : "close nominations";

  const grid = $("nomGrid");
  grid.innerHTML = "";
  const locked = runoff ? !!priv?.runoffPick : !!priv?.nominated;

  $("closeNomsRow").classList.toggle("hidden", !me.isHost);
  if (!alive) { hide($("nomLock")); hide($("nomDone")); return; }

  const chosen = locked ? (runoff ? priv.runoffPick : priv.nominated) : nomSel;
  for (const m of pool) {
    if (m.id === me.memberId) continue;
    const isSel = chosen.includes(m.id);
    const tile = pickTile(m, isSel, locked);
    tile.addEventListener("click", () => {
      if (nomSel.includes(m.id)) nomSel = nomSel.filter((x) => x !== m.id);
      else if (nomSel.length < seats) nomSel = [...nomSel, m.id];
      else nomSel = [...nomSel.slice(1), m.id];
      render();
    });
    grid.appendChild(tile);
  }
  $("nomLock").classList.toggle("hidden", locked);
  $("nomLock").disabled = nomSel.length !== seats;
  $("nomDone").classList.toggle("hidden", !locked);
}

function renderTrial(s, alive, phase) {
  const voting = phase === "verdict";
  const box = $("posters");
  box.innerHTML = "";
  const iAmAccused = (s.accused || []).some((a) => a.id === me.memberId);
  const canVote = voting && alive && !me.isHost && !iAmAccused;

  for (const a of s.accused || []) {
    const div = document.createElement("div");
    div.className = "poster";
    const votedThis = priv?.votedFor === a.id;
    div.innerHTML = `
      <span class="poster-wanted">WANTED</span>
      <span class="poster-name">${escapeHtml(nameOf(a.id))}</span>
      <span class="poster-sub">${a.count} finger${a.count === 1 ? "" : "s"} pointed</span>
    `;
    if (voting && !me.isHost) {
      const btn = document.createElement("button");
      btn.className = "btn btn-accent poster-vote" + (votedThis ? " voted" : "");
      btn.textContent = votedThis ? "your vote ✓" : "guilty";
      btn.disabled = !canVote || priv?.votedFor !== undefined;
      btn.addEventListener("click", () => {
        socket.emit("vote", { accusedId: a.id }, (r) => { if (r?.error) alert(r.error); });
      });
      div.appendChild(btn);
    }
    box.appendChild(div);
  }

  const drawnNote = s.drawnByLot ? "the runoff wouldn't break, so the deck drew the posters. " : "";
  $("trialLead").textContent = drawnNote + (voting
    ? (iAmAccused ? "the town votes on your fate. sit tight." : me.isHost ? "the vote is open. chase the stragglers, then close it." : "pick who hangs. choose well.")
    : "each gives their speech. then the mayor calls the vote.");
  $("callVoteRow").classList.toggle("hidden", !(me.isHost && !voting));
  $("closeVoteRow").classList.toggle("hidden", !(me.isHost && voting));
  $("voteDone").classList.toggle("hidden", !(voting && priv?.votedFor !== undefined));
}

function renderResults(s) {
  const v = s.verdict;
  if (!v) return;
  const [a, b] = (s.accused || []).map((x) => x.id);

  if (v.hung) {
    $("resultsHead").textContent = "the jury hangs.";
    $("resultsLead").textContent = "dead heat. talk it out - then the town votes again. same two on the posters.";
  } else {
    $("resultsHead").textContent = "the town has spoken.";
    // the card stays face-down - the dead keep their secrets until the mayor
    // flips the whole table
    $("resultsLead").textContent = `${nameOf(v.condemnedId)} swings. whether the town chose well, only the mayor knows.`;
  }

  // everyone sees the counts; who voted for whom is the mayor's to keep
  const box = $("tallyBox");
  box.innerHTML = "";
  const voters = {};
  for (const [voter, target] of Object.entries(priv?.ballot || {})) {
    (voters[target] = voters[target] || []).push(voter);
  }
  for (const id of [a, b].sort((x, y) => (v.counts[y] || 0) - (v.counts[x] || 0))) {
    const row = document.createElement("div");
    row.className = "tally-row" + (!v.hung && v.condemnedId === id ? " top" : "");
    const voterLine = me.isHost
      ? `<span class="tally-voters">${(voters[id] || []).map((x) => escapeHtml(nameOf(x))).join(", ")}</span>`
      : "";
    row.innerHTML = `
      <span class="tally-name">${escapeHtml(nameOf(id))}</span>
      <span class="tally-count">${v.counts[id] || 0} vote${(v.counts[id] || 0) === 1 ? "" : "s"}</span>
      ${voterLine}
    `;
    box.appendChild(row);
  }

  $("resultsActions").classList.toggle("hidden", !me.isHost);
  $("revoteBtn").classList.toggle("hidden", !v.hung);
  // a hung jury revotes; moving on to the next day is the fallback
  $("openNomsBtn2").classList.toggle("btn-accent", !v.hung);
  $("openNomsBtn2").classList.toggle("btn-secondary", v.hung);
}

function renderReveal(s) {
  const all = $("allCards");
  all.innerHTML = "";
  for (const [id, card] of Object.entries(s.allCards || {})) {
    all.appendChild(miniCard(id, card));
  }
  $("nextRow").classList.toggle("hidden", !me.isHost);
}

function miniCard(id, card) {
  const div = document.createElement("div");
  div.className = "mini-card" + (card.role === "mafia" ? " mafia" : "");
  div.innerHTML = `
    <img src="/cards/${card.code}.svg" alt="${card.rank}${card.suit}" draggable="false" />
    <span class="mini-name">${escapeHtml(nameOf(id))}</span>
    <span class="mini-title">${escapeHtml(card.title)}</span>
  `;
  return div;
}

function renderLedger(allCards) {
  const box = $("ledgerCards");
  box.innerHTML = "";
  for (const [id, card] of Object.entries(allCards)) {
    const div = miniCard(id, card);
    const m = memberById(id);
    if (m && m.inRound && !m.alive) div.classList.add("dead-hand");
    box.appendChild(div);
  }
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
  const showStatus = ["nominating", "runoff", "verdict"].includes(phase);
  for (const m of s.members) {
    const li = document.createElement("li");
    const dead = m.inRound && !m.alive;
    if (dead) li.classList.add("dead");
    if (showStatus && m.acted && m.alive && m.inRound) li.classList.add("acted");
    const tags = [];
    if (m.id === me.memberId) tags.push(`<span class="you-tag">you</span>`);
    if (m.isHost) tags.push(`<span class="mayor-tag">🎩 mayor</span>`);
    let status = "";
    if (phase !== "lobby" && !m.inRound && !m.isHost) status = "at the bar";
    else if (dead) status = "☠ dead";
    else if (showStatus && m.inRound) status = m.acted ? "done ✓" : "deciding…";
    li.innerHTML = `
      <div class="m-name">${escapeHtml(m.name)} ${tags.join(" ")}</div>
      <div class="m-status">${status}</div>
    `;
    if (me.isHost && phase !== "lobby" && m.inRound) {
      const sk = document.createElement("button");
      sk.className = "skull-btn";
      sk.textContent = m.alive ? "☠" : "↺";
      sk.title = m.alive ? `mark ${m.name} dead` : `revive ${m.name}`;
      sk.setAttribute("aria-label", sk.title);
      sk.addEventListener("click", () => {
        emitSimple("setAlive")({ memberId: m.id, alive: !m.alive });
      });
      li.appendChild(sk);
    }
    if (me.isHost && !m.isHost && phase === "lobby") {
      const x = document.createElement("button");
      x.className = "drop-btn";
      x.title = `drop ${m.name}`;
      x.setAttribute("aria-label", `drop ${m.name}`);
      x.textContent = "✕";
      x.addEventListener("click", () => {
        if (confirm(`show ${m.name} the door?`)) {
          emitSimple("dropMember")({ memberId: m.id });
        }
      });
      li.appendChild(x);
    }
    ul.appendChild(li);
  }
}

// ── wire up ────────────────────────────────────────────────────────────────

$("create").addEventListener("click", createRoom);
$("join").addEventListener("click", () => joinRoom());
// a table code in the field means you're joining, not hosting - covers
// typing, paste, autofill, and values the browser restores on back/reload
function syncCreate() {
  const joining = $("joinCode").value.trim().length > 0;
  $("create").disabled = joining;
  $("create").textContent = joining ? "clear the code to host" : "open the saloon";
}
$("joinCode").addEventListener("input", syncCreate);
window.addEventListener("pageshow", syncCreate);
syncCreate();
window.addEventListener("hashchange", applyHashMode);

$("leaveBtn").addEventListener("click", () => {
  if (!me.roomId) return;
  const midGame = latest && latest.phase !== "lobby" && !me.isHost;
  if (midGame && !confirm("walk out mid-game? your seat empties for good.")) return;
  if (!me.isHost) {
    socket?.emit("leave", {}, () => {});
    // forget the seat; the name sticks around for next time
    store.set(me.roomId, { name: (store.get(me.roomId) || {}).name });
  }
  exitToLobby();
});

$("renameBtn").addEventListener("click", () => {
  const n = (prompt("your name", me.name) || "").trim().slice(0, 40);
  if (!n || n === me.name) return;
  me.name = n;
  store.set(me.roomId, { ...(store.get(me.roomId) || {}), name: n });
  $("youAre").textContent = `you: ${n}${me.isHost ? " (mayor)" : ""}`;
  rejoin?.();
});

const emitSimple = (event) => (payload = {}) =>
  socket.emit(event, payload, (r) => { if (r?.error) alert(r.error); });

$("dealBtn").addEventListener("click", () => emitSimple("deal")());
$("redealBtn").addEventListener("click", () => emitSimple("deal")());
$("nextBtn").addEventListener("click", () => emitSimple("deal")());
$("openNomsBtn").addEventListener("click", () => emitSimple("openNominations")());
$("openNomsBtn2").addEventListener("click", () => emitSimple("openNominations")());
$("closeNomsBtn").addEventListener("click", () =>
  emitSimple(latest?.phase === "runoff" ? "closeRunoff" : "closeNominations")());
$("callVoteBtn").addEventListener("click", () => emitSimple("callVote")());
$("revoteBtn").addEventListener("click", () => emitSimple("revote")());
$("closeVoteBtn").addEventListener("click", () => emitSimple("closeVote")());
$("revealBtn").addEventListener("click", () => emitSimple("reveal")());
$("revealBtn2").addEventListener("click", () => emitSimple("reveal")());
$("revealBtn3").addEventListener("click", () => emitSimple("reveal")());

$("nomLock").addEventListener("click", () => {
  if (latest?.phase === "runoff") {
    if (nomSel.length !== latest.runoff.seats) return;
    emitSimple("runoffPick")({ picks: nomSel });
  } else {
    if (nomSel.length !== 2) return;
    emitSimple("nominate")({ picks: nomSel });
  }
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

// the ledger folds shut so a player glancing at the mayor's phone sees nothing
$("ledgerToggle").addEventListener("click", () => {
  $("ledgerCards").classList.toggle("hidden");
  const open = !$("ledgerCards").classList.contains("hidden");
  $("ledgerToggle").textContent = open ? "🎩 mayor's ledger - tap to hide" : "🎩 mayor's ledger - tap to peek";
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

// raise the curtain on arrival - once per visit, skipped on plain refreshes
(function raiseCurtains() {
  const el = $("curtains");
  let seen = false;
  try {
    seen = !!sessionStorage.getItem("mafia:curtains");
    sessionStorage.setItem("mafia:curtains", "1");
  } catch {}
  if (seen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.remove();
    return;
  }
  setTimeout(() => el.classList.add("open"), 500);
  setTimeout(() => el.remove(), 2700);
})();
