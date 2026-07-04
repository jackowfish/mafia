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
let priv = null;     // my private state (card, picks, sheriff findings)

// local UI selections, reset when the phase turns over
let nightSel = null;
let nomSel = [];
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
          $("youAre").textContent = `you: ${me.name}${me.isHost ? " (host)" : ""}`;
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
  night: "night",
  day: "sunrise",
  nominating: "nominations",
  trial: "the trial",
  verdict: "the vote",
  reveal: "judgment",
};

const NIGHT_PROMPTS = {
  mafia: "Pick your mark. They won't see morning - unless the Angel is watching.",
  sheriff: "Pick someone to tail tonight. By sunrise you'll know if they're the mafia.",
  angel: "Pick someone to watch over tonight. You can pick yourself.",
  mayor: "Point at whoever looks shifty - it does nothing, but every screen looks the same. Save your voice for sunrise.",
  town: "Point at whoever looks shifty. It changes nothing - but every screen looks the same, so nobody can tell who's who.",
};

function mayorScript(s) {
  const waiting = s.members.filter((m) => m.inRound && m.alive && !m.acted).map((m) => m.name);
  switch (s.phase) {
    case "night":
      return `Set the scene: "Night falls on the saloon. Eyes on your own screen, hands where I can see 'em." ` +
        (waiting.length ? `Still deciding: ${waiting.join(", ")}. Make your own pick too.` : "Everyone's in.");
    case "day": {
      let line = "A quiet night. Too quiet.";
      if (s.report?.victimId) {
        const c = s.report.victimCard;
        line = `${nameOf(s.report.victimId)} was found face-down at dawn. They were ${c ? c.title : "somebody"}.`;
      } else if (s.report?.saved) {
        line = "Shots rang out - but the Angel was watching. Everybody lives.";
      }
      return `Read it aloud: "${line}" Let the table argue a while, then open nominations.`;
    }
    case "nominating":
      return `Tell them: "Point two fingers, folks. The two most-accused stand trial." ` +
        (waiting.length ? `Still deciding: ${waiting.join(", ")}.` : "All accusations are in.");
    case "trial": {
      const names = (s.accused || []).map((a) => nameOf(a.id));
      return `Call them up: "${names.join(" and ")}, on your feet." Give each a speech - thirty seconds apiece, no interruptions. Then call the vote.`;
    }
    case "verdict":
      return `The vote is open: ${s.votesIn}/${s.votersTotal} in. Chase the stragglers, then read the verdict when it lands.`;
    case "reveal":
      return s.verdict
        ? `Read it slow: "${nameOf(s.verdict.condemnedId)}... ${s.verdict.wasMafia ? "was the mafia. Sleep easy, folks." : "was innocent. The mafia tips their hat."}" Shuffle up when the table's ready.`
        : "";
    default:
      return "";
  }
}

// ── render ─────────────────────────────────────────────────────────────────

const STAGES = ["stageLobby", "stageNight", "stageDay", "stageNoms", "stageTrial", "stageReveal"];

function render() {
  if (!latest) return;
  const s = latest;
  const phase = s.phase;
  const inRound = !!memberById(me.memberId)?.inRound;
  const alive = !!memberById(me.memberId)?.alive;
  const playing = inRound && phase !== "lobby";
  const iAmMayor = playing && s.mayorId === me.memberId;
  const isLead = me.isHost || iAmMayor;

  // a fresh deal → riffle the deck (not on first paint after a reload)
  if (phase === "night" && renderedRound !== null && s.round !== renderedRound) {
    runShuffle();
  }

  // reset local selections when the phase or round turns over
  if (phase !== renderedPhase || s.round !== renderedRound) {
    nightSel = null;
    nomSel = [];
    renderedPhase = phase;
    renderedRound = s.round;
  }

  // phase banner
  $("phaseLabel").textContent = PHASE_LABELS[phase] || phase;
  $("phaseLabel").dataset.phase = phase;
  $("scoreTown").textContent = s.score.town;
  $("scoreMafia").textContent = s.score.mafia;
  const waiting = s.members.filter((m) => m.inRound && !m.acted).length;
  const waitBits = [];
  if (s.round > 0) waitBits.push(`round ${s.round}`);
  if (s.mafiaCount > 0) waitBits.push(`${s.mafiaCount} mafia dealt`);
  if (["night", "nominating"].includes(phase) && waiting > 0) waitBits.push(`waiting on ${waiting}`);
  if (phase === "verdict") waitBits.push(`${s.votesIn}/${s.votersTotal} votes in`);
  $("waitLabel").textContent = waitBits.join(" · ");

  // settings
  $("setSheriff").checked = !!s.settings.sheriffEnabled;
  $("setAngel").checked = !!s.settings.angelEnabled;
  $("setMayor").checked = !!s.settings.mayorEnabled;
  $("setRevealAll").checked = !!s.settings.revealAllCards;

  // stages
  for (const id of STAGES) hide($(id));
  const stage = {
    lobby: "stageLobby",
    night: "stageNight",
    day: "stageDay",
    nominating: "stageNoms",
    trial: "stageTrial",
    verdict: "stageTrial",
    reveal: "stageReveal",
  }[phase];
  if (stage) show($(stage));

  // my card
  if (playing && priv?.card) {
    show($("myCardBox"));
    paintCard("cardImg", "cardTitle", priv.card);
  } else {
    hide($("myCardBox"));
  }

  // private + ghost notes
  const notes = [];
  if (priv?.sheriff && ["day", "nominating", "trial", "verdict"].includes(phase)) {
    const n = nameOf(priv.sheriff.targetId);
    notes.push(priv.sheriff.isMafia
      ? `🔎 You tailed ${n} last night. It's them - ${n} is the mafia.`
      : `🔎 You tailed ${n} last night. They're clean.`);
  }
  if (playing && priv?.partners?.length) {
    notes.push(`🔫 Your partner${priv.partners.length === 1 ? "" : "s"} in crime: ${priv.partners.map(nameOf).join(", ")}.`);
  }
  $("privateNote").textContent = notes.join(" ");
  $("privateNote").classList.toggle("hidden", notes.length === 0);

  // the mayor's teleprompter
  if (iAmMayor) {
    $("mayorPrompt").textContent = mayorScript(s);
    show($("mayorBox"));
  } else {
    hide($("mayorBox"));
  }

  let ghost = "";
  if (playing && !alive) ghost = "☠ you're dead. enjoy the show - no pointing, no voting.";
  if (!inRound && phase !== "lobby") ghost = "you're watching this round from the bar. you'll be dealt in at the next shuffle.";
  $("ghostNote").textContent = ghost;
  $("ghostNote").classList.toggle("hidden", !ghost);

  // per-stage rendering
  if (phase === "lobby") renderLobbyStage(s);
  if (phase === "night") renderNight(s, alive, inRound);
  if (phase === "day") renderDay(s, isLead);
  if (phase === "nominating") renderNoms(s, alive, inRound);
  if (phase === "trial" || phase === "verdict") renderTrial(s, alive, inRound, phase, isLead);
  if (phase === "reveal") renderReveal(s, isLead);

  // host/mayor escape hatch
  const forcible = isLead && ["night", "nominating", "verdict"].includes(phase);
  $("forceRow").classList.toggle("hidden", !forcible);

  renderMembers(s, phase);
}

function renderLobbyStage(s) {
  const n = s.members.length;
  const hint = n < s.minPlayers
    ? `${n} at the table - need at least ${s.minPlayers} to deal.`
    : `${n} at the table. share the link, then deal when everyone's seated.`;
  $("lobbyHint").textContent = hint;
  $("dealRow").classList.toggle("hidden", !me.isHost);
  $("dealBtn").disabled = n < s.minPlayers || n > s.maxPlayers;
  $("dealBtn").textContent = n > s.maxPlayers
    ? `too many players (max ${s.maxPlayers})`
    : "deal the cards";
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

function renderNight(s, alive, inRound) {
  const role = priv?.card?.role || "town";
  $("nightPrompt").textContent = inRound && alive ? NIGHT_PROMPTS[role] : "";
  const grid = $("nightGrid");
  grid.innerHTML = "";
  const locked = priv?.nightPick !== undefined;
  if (!inRound || !alive) { hide($("nightLock")); hide($("nightDone")); return; }

  const canSelf = role === "angel";
  for (const m of s.members) {
    if (!m.inRound || !m.alive) continue;
    if (m.id === me.memberId && !canSelf) continue;
    const isSel = locked ? priv.nightPick === m.id : nightSel === m.id;
    const tile = pickTile(m, isSel, locked);
    tile.addEventListener("click", () => { nightSel = m.id; render(); });
    grid.appendChild(tile);
  }
  $("nightLock").classList.toggle("hidden", locked);
  $("nightLock").disabled = !nightSel;
  $("nightDone").classList.toggle("hidden", !locked);
}

function renderDay(s, isLead) {
  const r = s.report;
  let text = "";
  if (r) {
    if (r.victimId) {
      const card = r.victimCard;
      text = `${nameOf(r.victimId)} was found face-down at dawn.` +
        (card ? ` They were ${card.title} (${card.rank}${card.suit}).` : "");
    } else if (r.saved) {
      text = "Shots rang out in the night - but the Angel was watching. Everybody lives.";
    } else {
      text = "A quiet night. Too quiet.";
    }
  }
  $("reportText").textContent = text;
  $("openNomsRow").classList.toggle("hidden", !isLead);
}

function renderNoms(s, alive, inRound) {
  const grid = $("nomGrid");
  grid.innerHTML = "";
  const locked = !!priv?.nominated;
  if (!inRound || !alive) { hide($("nomLock")); hide($("nomDone")); return; }

  const chosen = locked ? priv.nominated : nomSel;
  for (const m of s.members) {
    if (!m.inRound || !m.alive || m.id === me.memberId) continue;
    const isSel = chosen.includes(m.id);
    const tile = pickTile(m, isSel, locked);
    tile.addEventListener("click", () => {
      if (nomSel.includes(m.id)) nomSel = nomSel.filter((x) => x !== m.id);
      else if (nomSel.length < 2) nomSel = [...nomSel, m.id];
      else nomSel = [nomSel[1], m.id];
      render();
    });
    grid.appendChild(tile);
  }
  $("nomLock").classList.toggle("hidden", locked);
  $("nomLock").disabled = nomSel.length !== 2;
  $("nomDone").classList.toggle("hidden", !locked);
}

function renderTrial(s, alive, inRound, phase, isLead) {
  const voting = phase === "verdict";
  const box = $("posters");
  box.innerHTML = "";
  const iAmAccused = (s.accused || []).some((a) => a.id === me.memberId);
  const canVote = voting && inRound && alive && !iAmAccused;

  for (const a of s.accused || []) {
    const div = document.createElement("div");
    div.className = "poster";
    const votedThis = priv?.votedFor === a.id;
    div.innerHTML = `
      <span class="poster-wanted">WANTED</span>
      <span class="poster-name">${escapeHtml(nameOf(a.id))}</span>
      <span class="poster-sub">${a.count} finger${a.count === 1 ? "" : "s"} pointed</span>
    `;
    if (voting) {
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

  $("trialLead").textContent = voting
    ? (iAmAccused ? "the town votes on your fate. sit tight." : "pick who hangs. choose well.")
    : "each gives their speech. then the town decides.";
  $("callVoteRow").classList.toggle("hidden", !(isLead && !voting));
  $("voteDone").classList.toggle("hidden", !(voting && priv?.votedFor !== undefined));
}

function renderReveal(s, isLead) {
  const v = s.verdict;
  if (!v) return;
  const name = nameOf(v.condemnedId);
  paintCard("rvImg", "rvTitle", v.condemnedCard);
  // flip after paint so the animation runs
  requestAnimationFrame(() => $("revealCard").classList.remove("flipped"));

  $("revealHead").textContent = v.wasMafia ? "got 'em." : "wrong hunch.";
  const bits = [];
  if (v.hung) bits.push("The jury hung - a coin decided.");
  bits.push(`${name} swung as ${v.condemnedCard.title} (${v.condemnedCard.rank}${v.condemnedCard.suit}).`);
  if (v.wasMafia) bits.push("The town sleeps easy tonight. Point: town.");
  else {
    const mafiaNames = (v.mafiaIds || []).map(nameOf).join(" & ");
    bits.push(`The real mafia - ${mafiaNames} - walk${v.mafiaIds?.length === 1 ? "s" : ""} free. Point: mafia.`);
  }
  $("revealText").textContent = bits.join(" ");

  const all = $("allCards");
  all.innerHTML = "";
  if (v.allCards) {
    for (const [id, card] of Object.entries(v.allCards)) {
      const div = document.createElement("div");
      div.className = "mini-card" + (card.role === "mafia" ? " mafia" : "");
      div.innerHTML = `
        <img src="/cards/${card.code}.svg" alt="${card.rank}${card.suit}" draggable="false" />
        <span class="mini-name">${escapeHtml(nameOf(id))}</span>
        <span class="mini-title">${escapeHtml(card.title)}</span>
      `;
      all.appendChild(div);
    }
  }
  $("nextRow").classList.toggle("hidden", !isLead);
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
  const showStatus = ["night", "nominating", "verdict"].includes(phase);
  for (const m of s.members) {
    const li = document.createElement("li");
    if (!m.alive && m.inRound) li.classList.add("dead");
    if (showStatus && m.acted && m.alive && m.inRound) li.classList.add("acted");
    const tags = [];
    if (m.id === me.memberId) tags.push(`<span class="you-tag">you</span>`);
    if (m.isHost) tags.push(`<span class="host-tag">host</span>`);
    if (m.id === s.mayorId) tags.push(`<span class="mayor-tag">🎩 mayor</span>`);
    let status = "";
    if (phase !== "lobby" && !m.inRound) status = "at the bar";
    else if (m.inRound && !m.alive) status = "☠ dead";
    else if (showStatus) status = m.acted ? "done ✓" : "deciding…";
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
$("joinHash").addEventListener("click", () => joinRoom(hashCode()));
$("backToMain").addEventListener("click", () => {
  history.replaceState(null, "", location.pathname);
  applyHashMode();
});
window.addEventListener("hashchange", applyHashMode);

const emitSimple = (event) => (payload = {}) =>
  socket.emit(event, payload, (r) => { if (r?.error) alert(r.error); });

$("dealBtn").addEventListener("click", () => emitSimple("deal")());
$("nextBtn").addEventListener("click", () => emitSimple("deal")());
$("openNomsBtn").addEventListener("click", () => emitSimple("openNominations")());
$("callVoteBtn").addEventListener("click", () => emitSimple("callVote")());
$("forceBtn").addEventListener("click", () => emitSimple("force")());

$("nightLock").addEventListener("click", () => {
  if (!nightSel) return;
  emitSimple("nightPick")({ targetId: nightSel });
});
$("nomLock").addEventListener("click", () => {
  if (nomSel.length !== 2) return;
  emitSimple("nominate")({ picks: nomSel });
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
      mayorEnabled: $("setMayor").checked,
      revealAllCards: $("setRevealAll").checked,
    },
  });
}
for (const id of ["setSheriff", "setAngel", "setMayor", "setRevealAll"]) {
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
