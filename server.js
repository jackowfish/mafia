import express from "express";
import http from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const PORT = Number(process.env.PORT || 3000);

const redisOpts = { maxRetriesPerRequest: null, enableReadyCheck: true };
const redis = new Redis(REDIS_URL, redisOpts);
const pubClient = new Redis(REDIS_URL, redisOpts);
const subClient = pubClient.duplicate();

for (const [name, client] of [["redis", redis], ["pub", pubClient], ["sub", subClient]]) {
  client.on("error", (err) => console.error(`[${name}] redis error:`, err.message));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
io.adapter(createAdapter(pubClient, subClient));

app.use(express.json());
app.get("/health", (_req, res) => res.type("text/plain").send("ok"));
app.use(express.static(path.join(__dirname, "public")));

const rid = (n = 4) =>
  Array.from({ length: n }, () =>
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]
  ).join("");

const tok = () => crypto.randomBytes(16).toString("hex");

// ---------------------------------------------------------------------------
// the deck - every card is a face card, every card is a different position.
// classic mafia dealing: Ace = mafia, King = detective, Queen = doctor - here the protector is the Angel on the red ace.
// ---------------------------------------------------------------------------

const CARDS = {
  AS: { rank: "A", suit: "♠", red: false, role: "mafia",   title: "The Mafia",
        blurb: "Every night you pick somebody to put in the ground. Don't get caught." },
  AC: { rank: "A", suit: "♣", red: false, role: "mafia",   title: "The Mafia",
        blurb: "Every night you pick somebody to put in the ground. Don't get caught." },
  AD: { rank: "A", suit: "♦", red: true,  role: "mafia",   title: "The Mafia",
        blurb: "Every night you pick somebody to put in the ground. Don't get caught." },
  KH: { rank: "K", suit: "♥", red: true,  role: "sheriff", title: "The Sheriff",
        blurb: "Every night you investigate one player and learn whether they're the mafia." },
  AH: { rank: "A", suit: "♥", red: true,  role: "angel",   title: "The Angel",
        blurb: "Every night you pick one soul to watch over. If the mafia comes for them, they live." },
  KS: { rank: "K", suit: "♠", red: false, role: "mayor",   title: "The Mayor",
        blurb: "You run this town - in the open. Everyone knows you're clean. Read the prompts, keep the meeting moving." },
  JS: { rank: "J", suit: "♠", red: false, role: "town", title: "Townsperson" },
  JH: { rank: "J", suit: "♥", red: true,  role: "town", title: "Townsperson" },
  JD: { rank: "J", suit: "♦", red: true,  role: "town", title: "Townsperson" },
  JC: { rank: "J", suit: "♣", red: false, role: "town", title: "Townsperson" },
  QS: { rank: "Q", suit: "♠", red: false, role: "town", title: "Townsperson" },
  QD: { rank: "Q", suit: "♦", red: true,  role: "town", title: "Townsperson" },
  QC: { rank: "Q", suit: "♣", red: false, role: "town", title: "Townsperson" },
  QH: { rank: "Q", suit: "♥", red: true,  role: "town", title: "Townsperson" },
  KD: { rank: "K", suit: "♦", red: true,  role: "town", title: "Townsperson" },
  KC: { rank: "K", suit: "♣", red: false, role: "town", title: "Townsperson" },
};
const TOWN_BLURB = "You're just here for a drink. Watch faces, point fingers, and vote well.";
const TOWN_CODES = Object.keys(CARDS).filter((c) => CARDS[c].role === "town");
const MAFIA_CARDS = ["AS", "AC", "AD"];

// the black aces come out one at a time as the table grows
const mafiaCountFor = (n) => (n >= 13 ? 3 : n >= 9 ? 2 : 1);

const cardPublic = (code) => {
  const c = CARDS[code];
  return { code, rank: c.rank, suit: c.suit, red: c.red, role: c.role, title: c.title };
};

const defaultSettings = () => ({
  sheriffEnabled: true,
  angelEnabled: true,
  mayorEnabled: false,
  revealAllCards: true,
});

const specialsCount = (s) =>
  (s.sheriffEnabled ? 1 : 0) + (s.angelEnabled ? 1 : 0) + (s.mayorEnabled ? 1 : 0);
const minPlayersFor = (s) => Math.max(4, 2 + specialsCount(s));
const maxPlayersFor = (s) => TOWN_CODES.length + MAFIA_CARDS.length + specialsCount(s);

const keys = {
  meta: (r) => `room:${r}:meta`,
  members: (r) => `room:${r}:members`,
  game: (r) => `room:${r}:game`,
};

const TTL = 60 * 60 * 24;

async function touch(roomId) {
  await Promise.all([
    redis.expire(keys.meta(roomId), TTL),
    redis.expire(keys.members(roomId), TTL),
    redis.expire(keys.game(roomId), TTL),
  ]);
}

async function loadRoom(roomId) {
  const meta = await redis.hgetall(keys.meta(roomId));
  if (!meta || !meta.hostToken) return null;
  const members = await redis.hgetall(keys.members(roomId));
  const raw = await redis.get(keys.game(roomId));
  const game = raw ? JSON.parse(raw) : null;
  const settings = meta.settings ? JSON.parse(meta.settings) : defaultSettings();
  return { meta, members, game, settings };
}

async function saveGame(roomId, game) {
  await redis.set(keys.game(roomId), JSON.stringify(game), "EX", TTL);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newRound(memberIds, settings, prev) {
  const deck = MAFIA_CARDS.slice(0, mafiaCountFor(memberIds.length));
  if (settings.sheriffEnabled) deck.push("KH");
  if (settings.angelEnabled) deck.push("AH");
  if (settings.mayorEnabled) deck.push("KS");
  const townNeeded = memberIds.length - deck.length;
  deck.push(...shuffle(TOWN_CODES).slice(0, townNeeded));
  const dealt = shuffle(deck);
  const order = shuffle(memberIds);
  const cards = {};
  order.forEach((id, i) => (cards[id] = dealt[i]));
  return {
    round: prev ? prev.round + 1 : 1,
    score: prev ? prev.score : { town: 0, mafia: 0 },
    phase: "night",
    players: order,
    cards,
    alive: Object.fromEntries(order.map((id) => [id, true])),
    picks: {},          // night: memberId -> targetId
    report: null,       // { victimId, victimCard, saved }
    sheriff: null,      // { targetId, isMafia } - private to the sheriff
    nominations: {},    // memberId -> [a, b]
    tally: null,        // memberId -> nomination count
    accused: null,      // [idA, idB]
    votes: {},          // memberId -> accusedId
    verdict: null,      // { condemnedId, counts, hung, wasMafia, mafiaId }
  };
}

const findByRole = (g, role) =>
  g.players.find((id) => CARDS[g.cards[id]].role === role) || null;

const allByRole = (g, role) =>
  g.players.filter((id) => CARDS[g.cards[id]].role === role);

const aliveIds = (g) => g.players.filter((id) => g.alive[id]);

function actedThisPhase(g, id) {
  if (!g.alive[id]) return true;
  if (g.phase === "night") return g.picks[id] !== undefined;
  if (g.phase === "nominating") return g.nominations[id] !== undefined;
  if (g.phase === "verdict") {
    if (g.accused.includes(id)) return true; // the accused don't vote
    return g.votes[id] !== undefined;
  }
  return true;
}

function resolveNight(g) {
  const angelId = findByRole(g, "angel");
  const sheriffId = findByRole(g, "sheriff");
  // the mafia vote on the mark; most fingers wins, ties break random
  const killVotes = {};
  for (const id of allByRole(g, "mafia")) {
    const t = g.picks[id];
    if (t !== undefined) killVotes[t] = (killVotes[t] || 0) + 1;
  }
  const ranked = shuffle(Object.keys(killVotes)).sort((a, b) => killVotes[b] - killVotes[a]);
  const target = ranked[0];
  const saved = !!(angelId && g.alive[angelId] && g.picks[angelId] === target);
  const victimId = saved ? null : target;
  if (victimId) g.alive[victimId] = false;
  g.report = {
    victimId: victimId || null,
    victimCard: victimId ? g.cards[victimId] : null,
    saved,
  };
  if (sheriffId && g.alive[sheriffId] && g.picks[sheriffId] !== undefined) {
    const t = g.picks[sheriffId];
    g.sheriff = { targetId: t, isMafia: CARDS[g.cards[t]].role === "mafia" };
  }
  g.phase = "day";
}

function closeNominations(g) {
  const tally = {};
  for (const picks of Object.values(g.nominations)) {
    for (const id of picks) {
      if (g.alive[id]) tally[id] = (tally[id] || 0) + 1;
    }
  }
  const ranked = shuffle(Object.keys(tally)).sort((a, b) => tally[b] - tally[a]);
  if (ranked.length < 2) return false;
  g.tally = tally;
  g.accused = ranked.slice(0, 2);
  g.phase = "trial";
  return true;
}

function resolveVerdict(g) {
  const counts = { [g.accused[0]]: 0, [g.accused[1]]: 0 };
  for (const v of Object.values(g.votes)) {
    if (counts[v] !== undefined) counts[v] += 1;
  }
  const [a, b] = g.accused;
  const hung = counts[a] === counts[b];
  const condemnedId = hung
    ? g.accused[Math.floor(Math.random() * 2)]
    : counts[a] > counts[b] ? a : b;
  g.alive[condemnedId] = false;
  const wasMafia = CARDS[g.cards[condemnedId]].role === "mafia";
  if (wasMafia) g.score.town += 1;
  else g.score.mafia += 1;
  g.verdict = { condemnedId, counts, hung, wasMafia, mafiaIds: allByRole(g, "mafia") };
  g.phase = "reveal";
}

// ---------------------------------------------------------------------------
// state fan-out: one public payload for the room, one private payload
// per player (their card, their picks, the sheriff's findings)
// ---------------------------------------------------------------------------

function publicState(roomId, r) {
  const { meta, members, game: g, settings } = r;
  const memberIds = Object.keys(members);
  const out = {
    roomId,
    settings,
    minPlayers: minPlayersFor(settings),
    maxPlayers: maxPlayersFor(settings),
    phase: g ? g.phase : "lobby",
    round: g ? g.round : 0,
    score: g ? g.score : { town: 0, mafia: 0 },
    mafiaCount: g ? allByRole(g, "mafia").length : 0,
    mayorId: g ? findByRole(g, "mayor") : null, // the mayor's card is public
    members: memberIds.map((id) => ({
      id,
      name: members[id],
      isHost: id === meta.hostId,
      inRound: g ? g.players.includes(id) : false,
      alive: g ? !!g.alive[id] : true,
      acted: g ? actedThisPhase(g, id) : false,
    })),
  };
  if (!g) return out;

  const after = (...phases) => phases.includes(g.phase);
  if (after("day", "nominating", "trial", "verdict", "reveal") && g.report) {
    out.report = {
      victimId: g.report.victimId,
      victimCard: g.report.victimCard ? cardPublic(g.report.victimCard) : null,
      saved: g.report.saved,
    };
  }
  if (after("trial", "verdict", "reveal") && g.accused) {
    out.accused = g.accused.map((id) => ({ id, count: g.tally[id] || 0 }));
  }
  if (g.phase === "verdict") {
    out.votesIn = Object.keys(g.votes).length;
    out.votersTotal = aliveIds(g).filter((id) => !g.accused.includes(id)).length;
  }
  if (g.phase === "reveal" && g.verdict) {
    out.verdict = {
      condemnedId: g.verdict.condemnedId,
      condemnedCard: cardPublic(g.cards[g.verdict.condemnedId]),
      counts: g.verdict.counts,
      hung: g.verdict.hung,
      wasMafia: g.verdict.wasMafia,
      mafiaIds: g.verdict.mafiaIds,
    };
    if (settings.revealAllCards) {
      out.verdict.allCards = Object.fromEntries(
        g.players.map((id) => [id, cardPublic(g.cards[id])])
      );
    }
  }
  return out;
}

function privateState(g, id) {
  if (!g || !g.players.includes(id)) return { card: null };
  const code = g.cards[id];
  const card = { ...cardPublic(code), blurb: CARDS[code].blurb || TOWN_BLURB };
  const out = { card };
  if (g.picks[id] !== undefined) out.nightPick = g.picks[id];
  if (g.nominations[id]) out.nominated = g.nominations[id];
  if (g.votes[id] !== undefined) out.votedFor = g.votes[id];
  if (CARDS[code].role === "sheriff" && g.sheriff && g.phase !== "night") {
    out.sheriff = g.sheriff;
  }
  if (CARDS[code].role === "mafia") {
    const partners = allByRole(g, "mafia").filter((m) => m !== id);
    if (partners.length) out.partners = partners;
  }
  return out;
}

async function broadcast(roomId) {
  const r = await loadRoom(roomId);
  if (!r) return;
  io.to(roomId).emit("state", publicState(roomId, r));
  for (const id of Object.keys(r.members)) {
    io.to(`${roomId}:m:${id}`).emit("private", privateState(r.game, id));
  }
  touch(roomId).catch(() => {});
}

app.post("/api/rooms", async (req, res) => {
  const name = (req.body?.name || "Host").toString().slice(0, 40);
  let roomId;
  for (let i = 0; i < 5; i++) {
    roomId = rid();
    const exists = await redis.exists(keys.meta(roomId));
    if (!exists) break;
  }
  const hostId = crypto.randomUUID();
  const hostToken = tok();
  await redis.hset(keys.meta(roomId), {
    hostId,
    hostToken,
    settings: JSON.stringify(defaultSettings()),
    createdAt: Date.now().toString(),
  });
  await redis.hset(keys.members(roomId), hostId, name);
  await touch(roomId);
  res.json({ roomId, hostId, hostToken });
});

io.on("connection", (socket) => {
  let joined = null; // { roomId, memberId, isHost }

  // leadOnly = the host or the sitting mayor may do it
  const withRoom = (handler, { hostOnly = false, leadOnly = false } = {}) => async (payload, ack) => {
    try {
      if (!joined) return ack?.({ error: "not joined" });
      if (hostOnly && !joined.isHost) return ack?.({ error: "host only" });
      const r = await loadRoom(joined.roomId);
      if (!r) return ack?.({ error: "room not found" });
      if (leadOnly && !joined.isHost) {
        const isMayor = r.game && findByRole(r.game, "mayor") === joined.memberId;
        if (!isMayor) return ack?.({ error: "host or mayor only" });
      }
      const err = await handler(r, payload || {});
      if (err) return ack?.({ error: err });
      ack?.({ ok: true });
      broadcast(joined.roomId);
    } catch (e) {
      console.error("handler error:", e);
      ack?.({ error: "something went wrong" });
    }
  };

  socket.on("join", async ({ roomId, name, memberId, hostToken }, ack) => {
    roomId = (roomId || "").toUpperCase().trim();
    const r = await loadRoom(roomId);
    if (!r) return ack?.({ error: "room not found" });

    let id = memberId;
    let isHost = false;

    if (hostToken && hostToken === r.meta.hostToken) {
      id = r.meta.hostId;
      isHost = true;
    } else if (id && r.members[id]) {
      // returning member
    } else {
      id = crypto.randomUUID();
    }

    const displayName = (name || r.members[id] || "Stranger").toString().slice(0, 40);
    await redis.hset(keys.members(roomId), id, displayName);

    joined = { roomId, memberId: id, isHost };
    socket.join(roomId);
    socket.join(`${roomId}:m:${id}`);
    ack?.({ memberId: id, isHost });
    broadcast(roomId);
  });

  // host deals a fresh round. works from the lobby, from the reveal screen
  // ("next round"), or mid-round as an abandon-and-redeal.
  socket.on("deal", withRoom(async (r) => {
    const memberIds = Object.keys(r.members);
    const min = minPlayersFor(r.settings);
    const max = maxPlayersFor(r.settings);
    if (memberIds.length < min) return `need at least ${min} players`;
    if (memberIds.length > max) return `too many players - the deck holds ${max}`;
    const g = newRound(memberIds, r.settings, r.game);
    await saveGame(joined.roomId, g);
  }, { leadOnly: true }));

  socket.on("nightPick", withRoom(async (r, { targetId }) => {
    const g = r.game;
    if (!g || g.phase !== "night") return "it isn't night";
    const me = joined.memberId;
    if (!g.players.includes(me) || !g.alive[me]) return "you're not in this round";
    if (!g.players.includes(targetId) || !g.alive[targetId]) return "pick a living player";
    const myRole = CARDS[g.cards[me]].role;
    if (targetId === me && myRole !== "angel") return "you can't pick yourself";
    if (myRole === "mafia" && CARDS[g.cards[targetId]].role === "mafia") {
      return "you don't shoot your own";
    }
    g.picks[me] = targetId;
    if (aliveIds(g).every((id) => g.picks[id] !== undefined)) resolveNight(g);
    await saveGame(joined.roomId, g);
  }));

  socket.on("openNominations", withRoom(async (r) => {
    const g = r.game;
    if (!g || g.phase !== "day") return "wrong moment";
    g.phase = "nominating";
    await saveGame(joined.roomId, g);
  }, { leadOnly: true }));

  socket.on("nominate", withRoom(async (r, { picks }) => {
    const g = r.game;
    if (!g || g.phase !== "nominating") return "nominations aren't open";
    const me = joined.memberId;
    if (!g.players.includes(me) || !g.alive[me]) return "you're not in this round";
    if (!Array.isArray(picks) || picks.length !== 2) return "nominate exactly two players";
    const [a, b] = picks;
    if (a === b) return "pick two different players";
    for (const id of picks) {
      if (!g.players.includes(id) || !g.alive[id]) return "pick living players";
      if (id === me) return "you can't nominate yourself";
    }
    g.nominations[me] = [a, b];
    if (aliveIds(g).every((id) => g.nominations[id] !== undefined)) closeNominations(g);
    await saveGame(joined.roomId, g);
  }));

  socket.on("callVote", withRoom(async (r) => {
    const g = r.game;
    if (!g || g.phase !== "trial") return "wrong moment";
    g.phase = "verdict";
    await saveGame(joined.roomId, g);
  }, { leadOnly: true }));

  socket.on("vote", withRoom(async (r, { accusedId }) => {
    const g = r.game;
    if (!g || g.phase !== "verdict") return "the vote isn't open";
    const me = joined.memberId;
    if (!g.players.includes(me) || !g.alive[me]) return "you're not in this round";
    if (g.accused.includes(me)) return "the accused don't vote";
    if (!g.accused.includes(accusedId)) return "vote for one of the accused";
    g.votes[me] = accusedId;
    const voters = aliveIds(g).filter((id) => !g.accused.includes(id));
    if (voters.every((id) => g.votes[id] !== undefined)) resolveVerdict(g);
    await saveGame(joined.roomId, g);
  }));

  // host escape hatch when somebody wandered off mid-phase
  socket.on("force", withRoom(async (r) => {
    const g = r.game;
    if (!g) return "no round in progress";
    if (g.phase === "night") {
      if (!allByRole(g, "mafia").some((id) => g.picks[id] !== undefined)) {
        return "waiting on the killers - can't skip that";
      }
      resolveNight(g);
    } else if (g.phase === "nominating") {
      if (!closeNominations(g)) return "need at least two nominated players";
    } else if (g.phase === "verdict") {
      if (Object.keys(g.votes).length === 0) return "nobody has voted yet";
      resolveVerdict(g);
    } else {
      return "nothing to skip";
    }
    await saveGame(joined.roomId, g);
  }, { leadOnly: true }));

  socket.on("settings", withRoom(async (r, { settings }) => {
    const clean = {};
    for (const k of ["sheriffEnabled", "angelEnabled", "mayorEnabled", "revealAllCards"]) {
      if (typeof settings?.[k] === "boolean") clean[k] = settings[k];
    }
    const merged = { ...r.settings, ...clean };
    await redis.hset(keys.meta(joined.roomId), "settings", JSON.stringify(merged));
  }, { hostOnly: true }));

  socket.on("disconnect", () => {
    // keep membership so refreshes work; rooms expire via TTL
  });
});

server.listen(PORT, () => {
  console.log(`mafia listening on :${PORT}, redis=${REDIS_URL}`);
});
