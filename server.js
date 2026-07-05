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
// the deck - face cards are the roles, number cards are the townsfolk.
// classic mafia dealing: Ace = mafia, King of hearts = sheriff, the red ace
// is the Angel. the host holds the King of spades - the Mayor - and runs
// the table; everything past the deal happens out loud.
// ---------------------------------------------------------------------------

const CARDS = {
  AS: { rank: "A", suit: "♠", red: false, role: "mafia",   title: "The Mafia",
        blurb: "Every night you pick somebody to put in the ground. Don't get caught." },
  AC: { rank: "A", suit: "♣", red: false, role: "mafia",   title: "The Mafia",
        blurb: "Every night you pick somebody to put in the ground. Don't get caught." },
  AD: { rank: "A", suit: "♦", red: true,  role: "mafia",   title: "The Mafia",
        blurb: "Every night you pick somebody to put in the ground. Don't get caught." },
  KH: { rank: "K", suit: "♥", red: true,  role: "sheriff", title: "The Sheriff",
        blurb: "Every night you point at one player while the town sleeps - the mayor tells you if they're the mafia." },
  AH: { rank: "A", suit: "♥", red: true,  role: "angel",   title: "The Angel",
        blurb: "Every night you pick one soul to watch over. If the mafia comes for them, they live." },
  KS: { rank: "K", suit: "♠", red: false, role: "mayor",   title: "The Mayor",
        blurb: "You run this town - in the open. Everyone knows you're clean. Narrate the nights, then open the vote." },
};

const SUITS = { S: ["♠", false], H: ["♥", true], D: ["♦", true], C: ["♣", false] };
for (const r of ["2", "3", "4", "5", "6", "7", "8", "9", "T"]) {
  for (const [s, [suit, red]] of Object.entries(SUITS)) {
    CARDS[r + s] = { rank: r === "T" ? "10" : r, suit, red, role: "town", title: "Townsperson" };
  }
}
const TOWN_BLURB = "You're just here for a drink. Watch faces, point fingers, and vote well.";
const TOWN_CODES = Object.keys(CARDS).filter((c) => CARDS[c].role === "town");
const MAFIA_CARDS = ["AS", "AC", "AD"];

// the black aces come out one at a time as the table grows
const mafiaCountFor = (n) => (n >= 13 ? 3 : n >= 9 ? 2 : 1);

const cardPublic = (code) => {
  const c = CARDS[code];
  return { code, rank: c.rank, suit: c.suit, red: c.red, role: c.role, title: c.title };
};

const cardPrivate = (code) => ({ ...cardPublic(code), blurb: CARDS[code].blurb || TOWN_BLURB });

const defaultSettings = () => ({
  sheriffEnabled: true,
  angelEnabled: true,
});

const specialsCount = (s) =>
  (s.sheriffEnabled ? 1 : 0) + (s.angelEnabled ? 1 : 0);
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
  if (game) {
    // rounds dealt before a deploy may predate newer fields - backfill them
    game.alive ??= Object.fromEntries(game.players.map((id) => [id, true]));
    game.nominations ??= {};
    game.votes ??= {};
    game.runoff ??= null;
    if (game.runoff) game.runoff.attempt ??= 1;
  }
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

function newRound(playerIds, settings, prev) {
  const deck = MAFIA_CARDS.slice(0, mafiaCountFor(playerIds.length));
  if (settings.sheriffEnabled) deck.push("KH");
  if (settings.angelEnabled) deck.push("AH");
  const townNeeded = playerIds.length - deck.length;
  deck.push(...shuffle(TOWN_CODES).slice(0, townNeeded));
  const dealt = shuffle(deck);
  const order = shuffle(playerIds);
  const cards = {};
  order.forEach((id, i) => (cards[id] = dealt[i]));
  return {
    round: prev ? prev.round + 1 : 1,
    phase: "table",     // table -> nominating -> trial -> verdict -> results -> (nominating again | reveal)
    players: order,
    cards,
    alive: Object.fromEntries(order.map((id) => [id, true])),
    nominations: {},    // memberId -> [a, b]
    tally: null,        // nomineeId -> nomination count
    runoff: null,       // { candidates, seats, locked, picks, attempt } when the cut is tied
    drawnByLot: false,  // true when a twice-deadlocked runoff was cut by the deck
    accused: null,      // [idA, idB] - the two most-accused
    votes: {},          // memberId -> accusedId
    verdict: null,      // { counts, votes, hung, condemnedId }
  };
}

const allByRole = (g, role) =>
  g.players.filter((id) => CARDS[g.cards[id]].role === role);

const aliveIds = (g) => g.players.filter((id) => g.alive[id]);

// the app knows every hand, so it can call the game: town wins when the last
// mafia falls; mafia wins with the numbers (they control every vote and every
// night) - unless the angel still stands to keep the town breathing.
function gameOutcome(g) {
  const living = aliveIds(g);
  const mafia = living.filter((id) => CARDS[g.cards[id]].role === "mafia").length;
  if (mafia === 0) return "town";
  const angelStands = living.some((id) => CARDS[g.cards[id]].role === "angel");
  if (mafia >= living.length - mafia && !angelStands) return "mafia";
  return null;
}

// phases only ever wait on the living - call after anything that changes
// who's alive or who's still expected to act
function recheckPhase(g) {
  const living = aliveIds(g);
  if (!living.length) return;
  if (g.phase === "nominating" && living.every((id) => g.nominations[id] !== undefined)) {
    closeNominations(g);
  } else if (g.phase === "runoff" && living.every((id) => g.runoff.picks[id] !== undefined)) {
    closeRunoff(g);
  } else if (g.phase === "verdict") {
    const voters = living.filter((id) => !g.accused.includes(id));
    if (voters.length && voters.every((id) => g.votes[id] !== undefined)) closeVote(g);
  }
}

// a tie for the trial spots is never broken by chance or by the mayor -
// the tied candidates go to a runoff and the town points again
function closeNominations(g) {
  const tally = {};
  for (const picks of Object.values(g.nominations)) {
    for (const id of picks) tally[id] = (tally[id] || 0) + 1;
  }
  for (const id of Object.keys(tally)) {
    if (!g.players.includes(id) || !g.alive[id]) delete tally[id]; // nominee left or died
  }
  const ranked = Object.keys(tally).sort((a, b) => tally[b] - tally[a]);
  if (ranked.length < 2) return false;
  g.tally = tally;
  const cut = tally[ranked[1]];
  const locked = ranked.filter((id) => tally[id] > cut);
  const tied = ranked.filter((id) => tally[id] === cut);
  if (locked.length + tied.length === 2) {
    g.accused = [...locked, ...tied];
    g.phase = "trial";
  } else {
    g.runoff = { candidates: tied, seats: 2 - locked.length, locked, picks: {}, attempt: 1 };
    g.phase = "runoff";
  }
  return true;
}

function closeRunoff(g) {
  const ro = g.runoff;
  const counts = Object.fromEntries(ro.candidates.map((id) => [id, 0]));
  for (const picks of Object.values(ro.picks)) {
    for (const id of picks) counts[id] += 1;
  }
  const ranked = [...ro.candidates].sort((a, b) => counts[b] - counts[a]);
  const cut = counts[ranked[ro.seats - 1]];
  const winners = ranked.filter((id) => counts[id] > cut);
  const tied = ranked.filter((id) => counts[id] === cut);
  if (winners.length + tied.length === ro.seats) {
    g.accused = [...ro.locked, ...winners, ...tied];
    g.runoff = null;
    g.phase = "trial";
  } else if (winners.length === 0 && tied.length === ro.candidates.length) {
    // the runoff changed nothing. give the town one more crack at it, then
    // let the deck decide - with three players left the picks are forced and
    // no amount of re-pointing can ever break the tie.
    if (ro.attempt >= 2) {
      g.accused = [...ro.locked, ...shuffle(tied).slice(0, ro.seats)];
      g.drawnByLot = true;
      g.runoff = null;
      g.phase = "trial";
    } else {
      g.runoff = { ...ro, picks: {}, attempt: ro.attempt + 1 };
    }
  } else {
    // partial progress - narrow to the contested spots and point again
    g.runoff = {
      candidates: tied,
      seats: ro.seats - winners.length,
      locked: [...ro.locked, ...winners],
      picks: {},
      attempt: 1,
    };
  }
}

// ties hang the jury - the mayor makes the call at the table
function closeVote(g) {
  const [a, b] = g.accused;
  const counts = { [a]: 0, [b]: 0 };
  for (const v of Object.values(g.votes)) {
    if (counts[v] !== undefined) counts[v] += 1;
  }
  const hung = counts[a] === counts[b];
  const condemnedId = hung ? null : counts[a] > counts[b] ? a : b;
  if (condemnedId) g.alive[condemnedId] = false; // the town hanged them
  g.verdict = { counts, votes: { ...g.votes }, hung, condemnedId };
  g.phase = "results";
}

// pull somebody out of the running round (they left or got dropped).
// returns an error string, or null after cleanly removing them.
function removeFromRound(g, memberId) {
  if (!g || !g.players.includes(memberId)) return null;
  if (["trial", "verdict"].includes(g.phase) && g.accused.includes(memberId)) {
    return "not while they're on trial - see it through first";
  }
  if (g.phase === "runoff" && g.runoff.candidates.includes(memberId)) {
    return "not mid-runoff - settle it first";
  }
  g.players = g.players.filter((id) => id !== memberId);
  delete g.cards[memberId];
  delete g.alive[memberId];
  delete g.nominations[memberId];
  delete g.votes[memberId];
  if (g.runoff) delete g.runoff.picks[memberId];
  recheckPhase(g); // their exit might be the last thing a phase was waiting on
  return null;
}

// ---------------------------------------------------------------------------
// state fan-out: one public payload for the room, one private payload
// per player (their card, their vote, their partners in crime)
// ---------------------------------------------------------------------------

function actedThisPhase(g, id) {
  if (!g.alive[id]) return true; // nobody waits on the dead
  if (g.phase === "nominating") return g.nominations[id] !== undefined;
  if (g.phase === "runoff") return g.runoff.picks[id] !== undefined;
  if (g.phase === "verdict") {
    if (g.accused.includes(id)) return true; // the accused don't vote
    return g.votes[id] !== undefined;
  }
  return false;
}

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
    mafiaCount: g ? allByRole(g, "mafia").length : 0,
    members: memberIds.map((id) => ({
      id,
      name: members[id],
      isHost: id === meta.hostId,
      inRound: g ? g.players.includes(id) : false,
      alive: g && g.players.includes(id) ? !!g.alive[id] : true,
      acted: g && g.players.includes(id) ? actedThisPhase(g, id) : false,
    })),
  };
  if (!g) return out;

  out.winner = gameOutcome(g);

  if (g.phase === "nominating") {
    out.nomsIn = Object.keys(g.nominations).length;
    out.nomsTotal = aliveIds(g).length;
  }
  if (g.phase === "runoff") {
    out.runoff = {
      candidates: g.runoff.candidates,
      seats: g.runoff.seats,
      locked: g.runoff.locked,
      attempt: g.runoff.attempt,
      picksIn: Object.keys(g.runoff.picks).length,
      picksTotal: aliveIds(g).length,
    };
  }
  if (["trial", "verdict", "results"].includes(g.phase) && g.accused) {
    out.accused = g.accused.map((id) => ({ id, count: g.tally[id] || 0 }));
    out.drawnByLot = !!g.drawnByLot;
  }
  if (g.phase === "verdict") {
    out.votesIn = Object.keys(g.votes).length;
    out.votersTotal = aliveIds(g).filter((id) => !g.accused.includes(id)).length;
  }
  // the verdict names the hanged and the counts - but never their card, and
  // never who voted for whom. the ballot is the mayor's to keep.
  if (g.phase === "results" && g.verdict) {
    const { counts, hung, condemnedId } = g.verdict;
    out.verdict = { counts, hung, condemnedId };
  }
  if (g.phase === "reveal") {
    out.allCards = Object.fromEntries(
      g.players.map((id) => [id, cardPublic(g.cards[id])])
    );
  }
  return out;
}

function privateState(r, id) {
  const g = r.game;
  if (!g) return { card: null };
  // the mayor narrates the nights, so they see every hand - and the ballot
  if (id === r.meta.hostId) {
    const out = {
      card: cardPrivate("KS"),
      allCards: Object.fromEntries(g.players.map((p) => [p, cardPublic(g.cards[p])])),
    };
    if (g.phase === "results" && g.verdict) out.ballot = g.verdict.votes;
    // parity with the angel alive isn't over - but saying so publicly would
    // out the angel, so only the mayor hears it
    if (!gameOutcome(g)) {
      const living = aliveIds(g);
      const mafia = living.filter((p) => CARDS[g.cards[p]].role === "mafia").length;
      if (mafia > 0 && mafia >= living.length - mafia) {
        out.mayorNote = "the mafia has the numbers - the angel is all that stands between them and the town.";
      }
    }
    return out;
  }
  if (!g.players.includes(id)) return { card: null };
  const code = g.cards[id];
  const out = { card: cardPrivate(code) };
  if (g.nominations[id]) out.nominated = g.nominations[id];
  if (g.runoff?.picks[id]) out.runoffPick = g.runoff.picks[id];
  if (g.votes[id] !== undefined) out.votedFor = g.votes[id];
  if (CARDS[code].role === "mafia") {
    const partners = allByRole(g, "mafia").filter((m) => m !== id);
    if (partners.length) out.partners = partners;
  }
  return out;
}

async function broadcast(roomId) {
  // never let one bad room take the process down - broadcast runs unawaited
  try {
    const r = await loadRoom(roomId);
    if (!r) return;
    io.to(roomId).emit("state", publicState(roomId, r));
    for (const id of Object.keys(r.members)) {
      io.to(`${roomId}:m:${id}`).emit("private", privateState(r, id));
    }
    touch(roomId).catch(() => {});
  } catch (e) {
    console.error(`broadcast failed for room ${roomId}:`, e);
  }
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

  // liveness probe - waking phones use this to spot zombie sockets
  socket.on("hi", (_payload, ack) => ack?.({ ok: true }));

  const withRoom = (handler, { hostOnly = false } = {}) => async (payload, ack) => {
    try {
      if (!joined) return ack?.({ error: "not joined" });
      if (hostOnly && !joined.isHost) return ack?.({ error: "host only" });
      const r = await loadRoom(joined.roomId);
      if (!r) return ack?.({ error: "room not found" });
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
      // no usable member id - reclaim a seat by name if one exists, so the
      // same person joining again doesn't fill a second chair
      const wanted = (name || "").trim().toLowerCase();
      const seat = wanted && Object.entries(r.members).find(
        ([mid, n]) => mid !== r.meta.hostId && n.trim().toLowerCase() === wanted
      );
      id = seat ? seat[0] : crypto.randomUUID();
    }

    const displayName = (name || r.members[id] || "Stranger").toString().slice(0, 40);
    await redis.hset(keys.members(roomId), id, displayName);

    joined = { roomId, memberId: id, isHost };
    socket.join(roomId);
    socket.join(`${roomId}:m:${id}`);
    ack?.({ memberId: id, isHost });
    broadcast(roomId);
  });

  // host shuffles up a fresh round. the host is never dealt in - they hold
  // the Mayor card and run the table. works from anywhere as a redeal.
  socket.on("deal", withRoom(async (r) => {
    const playerIds = Object.keys(r.members).filter((id) => id !== r.meta.hostId);
    const min = minPlayersFor(r.settings);
    const max = maxPlayersFor(r.settings);
    if (playerIds.length < min) return `need at least ${min} players besides the mayor`;
    if (playerIds.length > max) return `too many players - the deck holds ${max}`;
    const g = newRound(playerIds, r.settings, r.game);
    await saveGame(joined.roomId, g);
  }, { hostOnly: true }));

  socket.on("openNominations", withRoom(async (r) => {
    const g = r.game;
    if (!g || !["table", "results"].includes(g.phase)) return "wrong moment";
    g.nominations = {};
    g.tally = null;
    g.runoff = null;
    g.accused = null;
    g.votes = {};
    g.verdict = null;
    g.drawnByLot = false;
    g.phase = "nominating";
    await saveGame(joined.roomId, g);
  }, { hostOnly: true }));

  socket.on("nominate", withRoom(async (r, { picks }) => {
    const g = r.game;
    if (!g || g.phase !== "nominating") return "nominations aren't open";
    const me = joined.memberId;
    if (!g.players.includes(me)) return "you're not in this round";
    if (!g.alive[me]) return "the dead don't point fingers";
    if (!Array.isArray(picks) || picks.length !== 2) return "nominate exactly two players";
    const [a, b] = picks;
    if (a === b) return "pick two different players";
    for (const id of picks) {
      if (!g.players.includes(id) || !g.alive[id]) return "pick living players";
      if (id === me) return "you can't nominate yourself";
    }
    g.nominations[me] = [a, b];
    recheckPhase(g);
    await saveGame(joined.roomId, g);
  }));

  // host closes nominations early - dead players don't point fingers
  socket.on("closeNominations", withRoom(async (r) => {
    const g = r.game;
    if (!g || g.phase !== "nominating") return "nominations aren't open";
    if (!closeNominations(g)) return "need at least two nominated players";
    await saveGame(joined.roomId, g);
  }, { hostOnly: true }));

  socket.on("runoffPick", withRoom(async (r, { picks }) => {
    const g = r.game;
    if (!g || g.phase !== "runoff") return "there's no runoff";
    const me = joined.memberId;
    if (!g.players.includes(me)) return "you're not in this round";
    if (!g.alive[me]) return "the dead don't point fingers";
    const ro = g.runoff;
    if (!Array.isArray(picks) || picks.length !== ro.seats) {
      return `pick exactly ${ro.seats === 1 ? "one" : "two"} of the tied`;
    }
    if (new Set(picks).size !== picks.length) return "pick different players";
    for (const id of picks) {
      if (!ro.candidates.includes(id)) return "pick among the tied";
      if (id === me) return "you can't pick yourself";
    }
    ro.picks[me] = picks;
    recheckPhase(g);
    await saveGame(joined.roomId, g);
  }));

  socket.on("closeRunoff", withRoom(async (r) => {
    const g = r.game;
    if (!g || g.phase !== "runoff") return "there's no runoff";
    if (Object.keys(g.runoff.picks).length === 0) return "nobody has picked yet";
    closeRunoff(g);
    await saveGame(joined.roomId, g);
  }, { hostOnly: true }));

  socket.on("callVote", withRoom(async (r) => {
    const g = r.game;
    if (!g || g.phase !== "trial") return "wrong moment";
    g.phase = "verdict";
    await saveGame(joined.roomId, g);
  }, { hostOnly: true }));

  socket.on("vote", withRoom(async (r, { accusedId }) => {
    const g = r.game;
    if (!g || g.phase !== "verdict") return "the vote isn't open";
    const me = joined.memberId;
    if (!g.players.includes(me)) return "you're not in this round";
    if (!g.alive[me]) return "the dead don't vote";
    if (g.accused.includes(me)) return "the accused don't vote";
    if (!g.accused.includes(accusedId)) return "vote for one of the accused";
    g.votes[me] = accusedId;
    recheckPhase(g);
    await saveGame(joined.roomId, g);
  }));

  // host closes the vote early - dead players don't vote, so the mayor
  // calls it whenever everyone still standing is in
  socket.on("closeVote", withRoom(async (r) => {
    const g = r.game;
    if (!g || g.phase !== "verdict") return "the vote isn't open";
    if (Object.keys(g.votes).length === 0) return "nobody has voted yet";
    closeVote(g);
    await saveGame(joined.roomId, g);
  }, { hostOnly: true }));

  // hung jury: same two accused, the town talks it out and votes again.
  // the mayor knows every hand, so the tiebreak is never theirs to make.
  socket.on("revote", withRoom(async (r) => {
    const g = r.game;
    if (!g || g.phase !== "results" || !g.verdict?.hung) return "the jury isn't hung";
    g.votes = {};
    g.verdict = null;
    g.phase = "verdict";
    await saveGame(joined.roomId, g);
  }, { hostOnly: true }));

  // flip every card face-up - the round is over
  socket.on("reveal", withRoom(async (r) => {
    const g = r.game;
    if (!g) return "no round in progress";
    g.phase = "reveal";
    await saveGame(joined.roomId, g);
  }, { hostOnly: true }));

  // the mayor calls a death (night kill read out loud) - or undoes a misclick.
  // hangings mark themselves when the verdict closes.
  socket.on("setAlive", withRoom(async (r, { memberId, alive }) => {
    const g = r.game;
    if (!g) return "no round in progress";
    if (typeof alive !== "boolean") return "bad call";
    if (!g.players.includes(memberId)) return "they're not in this round";
    if (!alive && ["trial", "verdict"].includes(g.phase) && g.accused.includes(memberId)) {
      return "not while they're on trial - see it through first";
    }
    if (!alive && g.phase === "runoff" && g.runoff.candidates.includes(memberId)) {
      return "not mid-runoff - settle it first";
    }
    g.alive[memberId] = alive;
    if (!alive) {
      // the dead take their pending fingers and ballots with them
      delete g.nominations[memberId];
      delete g.votes[memberId];
      if (g.runoff) delete g.runoff.picks[memberId];
      recheckPhase(g);
    }
    await saveGame(joined.roomId, g);
  }, { hostOnly: true }));

  // a player walks out - their seat empties for good
  socket.on("leave", withRoom(async (r) => {
    const me = joined.memberId;
    if (me === r.meta.hostId) return "the mayor can't leave their own table";
    const err = removeFromRound(r.game, me);
    if (err) return err;
    await redis.hdel(keys.members(joined.roomId), me);
    if (r.game) await saveGame(joined.roomId, r.game);
  }));

  // the mayor shows somebody the door
  socket.on("dropMember", withRoom(async (r, { memberId }) => {
    if (memberId === r.meta.hostId) return "you can't drop yourself";
    if (!r.members[memberId]) return "no such player";
    const err = removeFromRound(r.game, memberId);
    if (err) return err;
    await redis.hdel(keys.members(joined.roomId), memberId);
    if (r.game) await saveGame(joined.roomId, r.game);
    io.to(`${joined.roomId}:m:${memberId}`).emit("kicked");
  }, { hostOnly: true }));

  socket.on("settings", withRoom(async (r, { settings }) => {
    const clean = {};
    for (const k of ["sheriffEnabled", "angelEnabled"]) {
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
