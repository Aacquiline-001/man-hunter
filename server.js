// Pursuit — authoritative game server (Express + Socket.io)
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
// Map tiles: set MAPTILER_KEY in the environment to use MapTiler; otherwise free CARTO tiles are used.
app.get('/config.js', (req, res) => {
  res.type('application/javascript').send(
    `window.PURSUIT_CONFIG = ${JSON.stringify({ maptilerKey: process.env.MAPTILER_KEY || '' })};`
  );
});
app.use(express.static(path.join(__dirname, 'public')));

// All durations in seconds at speed x1. Demo speed (x6) divides them.
const CFG = {
  HEAD_START: 180,     // runners' head start
  GAME: 30 * 60,       // hunt length after head start
  PING: 120,           // hunters see every runner this often
  SHRINK: 300,         // zone shrinks this often
  SHRINK_FACTOR: 0.8,  // new radius = old * factor
  MIN_RADIUS: 60,      // metres
  OUTSIDE_LIVE: 30,    // seconds outside zone before going live
  TAG_RADIUS: 25,      // metres a hunter must be within to tag
};

const rooms = new Map();
const BOT_NAMES = ['Asha', 'Ravi', 'Neha', 'Arjun', 'Meera', 'Kabir', 'Isha', 'Dev', 'Tara', 'Vikram'];

// ---------- geo helpers ----------
const R_EARTH = 6371000;
const rad = d => (d * Math.PI) / 180;
function dist(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}
function offset(c, dx, dy) {
  return { lat: c.lat + dy / 111320, lng: c.lng + dx / (111320 * Math.cos(rad(c.lat))) };
}
function randomPointIn(c, r) {
  const a = Math.random() * 2 * Math.PI, d = r * Math.sqrt(Math.random());
  return offset(c, Math.cos(a) * d, Math.sin(a) * d);
}
function moveToward(p, target, metres) {
  const d = dist(p.pos, target);
  if (d <= metres) { p.pos = { ...target }; return; }
  const f = metres / d;
  p.pos = { lat: p.pos.lat + (target.lat - p.pos.lat) * f, lng: p.pos.lng + (target.lng - p.pos.lng) * f };
}

// ---------- room helpers ----------
function newCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => L[Math.floor(Math.random() * L.length)]).join(''); } while (rooms.has(c));
  return c;
}
const ms = (r, sec) => (sec * 1000) / r.speed;
function log(r, text) { r.log.push({ id: ++r.logId, t: Date.now(), text }); if (r.log.length > 40) r.log.shift(); }
const humans = r => Object.values(r.players).filter(p => !p.bot);

function newPlayer(id, name, bot = false) {
  return { id, name: (name || 'Player').trim().slice(0, 16) || 'Player', role: 'runner', pos: null, tagged: false,
    tagPos: null, lastPing: null, live: false, outsideSince: null, bot, online: true, sock: null, target: null };
}

function tag(r, p, by) {
  if (p.tagged) return;
  p.tagged = true; p.tagPos = p.pos; p.live = false; p.outsideSince = null;
  log(r, by ? `${by.name} tagged ${p.name}!` : `${p.name} was tagged`);
}

function endGame(r, winner) {
  r.phase = 'over'; r.winner = winner;
  log(r, winner === 'hunters' ? 'Hunters caught everyone!' : 'Time! Runners win.');
}

function viewFor(r, me) {
  const t = Date.now();
  const open = r.phase === 'lobby' || r.phase === 'over';
  const players = Object.values(r.players).map(p => {
    const base = { id: p.id, name: p.name, role: p.role, tagged: p.tagged, bot: p.bot, online: p.online };
    if (p.id === me.id) return { ...base, self: true, pos: p.pos, ghost: p.lastPing, live: p.live, outsideSince: p.outsideSince };
    if (open) return { ...base, pos: p.pos };
    if (me.role === 'hunter') {
      if (p.role === 'hunter') return { ...base, pos: p.pos };
      if (p.tagged) return { ...base, pos: p.tagPos };
      if (r.phase === 'play' && p.live) return { ...base, pos: p.pos, live: true };
      return { ...base, ghost: r.phase === 'play' ? p.lastPing : null };
    }
    // runner's view: teammates live, hunters hidden
    if (p.role === 'runner') return { ...base, pos: p.tagged ? p.tagPos : p.pos };
    return base;
  });
  return {
    code: r.code, phase: r.phase, hostId: r.hostId, me: me.id, zone: r.zone, speed: r.speed, winner: r.winner,
    now: t, times: { huntStart: r.huntStart, endAt: r.endAt, nextPingAt: r.nextPingAt, nextShrinkAt: r.nextShrinkAt },
    cfg: { ping: ms(r, CFG.PING), shrink: ms(r, CFG.SHRINK), outside: ms(r, CFG.OUTSIDE_LIVE), headStart: ms(r, CFG.HEAD_START), tagRadius: CFG.TAG_RADIUS },
    players, log: r.log.slice(-20),
  };
}

function push(r) {
  for (const p of humans(r)) if (p.online && p.sock) io.to(p.sock).emit('state', viewFor(r, p));
}

// ---------- bots ----------
function moveBots(r) {
  if (r.phase !== 'headstart' && r.phase !== 'play') return;
  const all = Object.values(r.players);
  for (const b of all) {
    if (!b.bot || !b.pos || b.tagged) continue;
    if (b.role === 'runner') {
      if (!b.target || dist(b.pos, b.target) < 8) b.target = randomPointIn(r.zone, r.zone.r * 0.85);
      moveToward(b, b.target, 1.4 * r.speed);
    } else if (r.phase === 'play') {
      // chase the nearest thing a hunter can actually see
      let best = null, bd = Infinity;
      for (const p of all) {
        if (p.role !== 'runner' || p.tagged || !p.pos) continue;
        const seen = p.live ? p.pos : p.lastPing;
        if (!seen) continue;
        const d = dist(b.pos, seen);
        if (d < bd) { bd = d; best = seen; }
      }
      if (!best && (!b.target || dist(b.pos, b.target) < 8)) b.target = randomPointIn(r.zone, r.zone.r * 0.8);
      moveToward(b, best || b.target, 2.2 * r.speed);
      for (const p of all) {
        if (p.role === 'runner' && !p.tagged && p.pos && dist(b.pos, p.pos) <= CFG.TAG_RADIUS) tag(r, p, b);
      }
    }
  }
}

// ---------- main loop ----------
function tick(r) {
  const t = Date.now();
  moveBots(r);

  if (r.phase === 'headstart' && t >= r.huntStart) {
    r.phase = 'play';
    r.nextPingAt = t + ms(r, CFG.PING);
    r.nextShrinkAt = t + ms(r, CFG.SHRINK);
    r.endAt = t + ms(r, CFG.GAME);
    log(r, 'The hunt is on!');
  }

  if (r.phase === 'play') {
    const runners = Object.values(r.players).filter(p => p.role === 'runner');

    if (t >= r.nextPingAt) {
      for (const p of runners) if (!p.tagged && p.pos) p.lastPing = { ...p.pos, t };
      r.nextPingAt += ms(r, CFG.PING);
      log(r, 'Ping! Hunters can see every runner.');
    }

    if (t >= r.nextShrinkAt) {
      const newR = Math.max(CFG.MIN_RADIUS, r.zone.r * CFG.SHRINK_FACTOR);
      const c = randomPointIn(r.zone, (r.zone.r - newR) * 0.6);
      r.zone = { lat: c.lat, lng: c.lng, r: newR };
      r.nextShrinkAt += ms(r, CFG.SHRINK);
      log(r, 'The zone just shrank!');
    }

    for (const p of runners) {
      if (p.tagged || !p.pos) continue;
      if (dist(p.pos, r.zone) > r.zone.r) {
        if (!p.outsideSince) p.outsideSince = t;
        const wasLive = p.live;
        p.live = t - p.outsideSince >= ms(r, CFG.OUTSIDE_LIVE);
        if (p.live && !wasLive) log(r, `${p.name} is outside the zone — now live!`);
      } else { p.outsideSince = null; p.live = false; }
    }

    if (runners.length && runners.every(p => p.tagged)) endGame(r, 'hunters');
    else if (t >= r.endAt) endGame(r, 'runners');
  }

  push(r);
}
setInterval(() => {
  const t = Date.now();
  for (const [code, r] of rooms) {
    if (humans(r).some(p => p.online)) r.lastActive = t;
    else if (t - r.lastActive > 10 * 60 * 1000) { rooms.delete(code); continue; }
    tick(r);
  }
}, 1000);

// ---------- sockets ----------
io.on('connection', sock => {
  let room = null, pid = null;
  const me = () => room && room.players[pid];
  const isHost = () => room && room.hostId === pid;

  function attach(r, id, name) {
    let p = r.players[id];
    if (!p) {
      if (r.phase !== 'lobby') return 'That game has already started';
      p = r.players[id] = newPlayer(id, name);
      log(r, `${p.name} joined`);
    }
    if (room && room !== r) sock.leave(room.code);
    room = r; pid = id;
    p.sock = sock.id; p.online = true;
    sock.join(r.code);
    return null;
  }

  sock.on('create', ({ name, pid: id }, cb) => {
    if (!id) return cb?.({ error: 'Missing player id' });
    const code = newCode();
    const r = { code, hostId: id, players: {}, phase: 'lobby', zone: null, initialR: null, speed: 1, log: [], logId: 0,
      winner: null, lastActive: Date.now() };
    rooms.set(code, r);
    attach(r, id, name);
    cb?.({ ok: true, code });
    push(r);
  });

  sock.on('join', ({ code, name, pid: id }, cb) => {
    const r = rooms.get(String(code || '').trim().toUpperCase());
    if (!r) return cb?.({ error: 'No game with that code' });
    const err = attach(r, id, name);
    if (err) return cb?.({ error: err });
    cb?.({ ok: true, code: r.code });
    push(r);
  });

  sock.on('role', role => {
    const p = me();
    if (!p || room.phase !== 'lobby' || !['runner', 'hunter'].includes(role)) return;
    p.role = role; push(room);
  });

  sock.on('zone', z => {
    if (!isHost() || room.phase !== 'lobby' || !z) return;
    const r = Math.min(3000, Math.max(80, Number(z.r) || 300));
    room.zone = { lat: Number(z.lat), lng: Number(z.lng), r };
    room.initialR = r;
    push(room);
  });

  sock.on('loc', pos => {
    const p = me();
    if (!p || !pos || !isFinite(pos.lat) || !isFinite(pos.lng)) return;
    if (p.tagged && room.phase === 'play') return; // tagged runners are frozen on the map
    p.pos = { lat: Number(pos.lat), lng: Number(pos.lng) };
  });

  sock.on('speed', s => { if (isHost() && room.phase === 'lobby') { room.speed = s === 6 ? 6 : 1; push(room); } });

  sock.on('addBot', (role, cb) => {
    if (!isHost() || room.phase !== 'lobby') return;
    const anchor = room.zone || me().pos;
    if (!anchor) return cb?.({ error: 'Draw the zone first' });
    const used = new Set(Object.values(room.players).map(p => p.name));
    const name = BOT_NAMES.find(n => !used.has(n)) || `Bot${Object.keys(room.players).length}`;
    const id = 'bot-' + Math.random().toString(36).slice(2, 9);
    const b = newPlayer(id, name, true);
    b.role = role === 'hunter' ? 'hunter' : 'runner';
    b.pos = randomPointIn(anchor, (room.zone ? room.zone.r : 200) * 0.7);
    room.players[id] = b;
    log(room, `${name} (bot) joined as ${b.role}`);
    push(room); cb?.({ ok: true });
  });

  sock.on('clearBots', () => {
    if (!isHost() || room.phase !== 'lobby') return;
    for (const p of Object.values(room.players)) if (p.bot) delete room.players[p.id];
    push(room);
  });

  sock.on('start', cb => {
    if (!isHost() || room.phase !== 'lobby') return;
    const ps = Object.values(room.players);
    if (!room.zone) return cb?.({ error: 'Draw the zone first' });
    if (!ps.some(p => p.role === 'runner')) return cb?.({ error: 'Need at least one runner' });
    if (!ps.some(p => p.role === 'hunter')) return cb?.({ error: 'Need at least one hunter' });
    for (const p of ps) Object.assign(p, { tagged: false, tagPos: null, lastPing: null, live: false, outsideSince: null, target: null });
    room.zone.r = room.initialR;
    room.winner = null;
    room.phase = 'headstart';
    room.huntStart = Date.now() + ms(room, CFG.HEAD_START);
    room.endAt = room.nextPingAt = room.nextShrinkAt = null;
    log(room, 'Runners, go! Hunters, hold tight.');
    push(room); cb?.({ ok: true });
  });

  sock.on('tag', cb => {
    const p = me();
    if (!p || p.role !== 'hunter' || room.phase !== 'play' || !p.pos) return cb?.({ error: 'Can’t tag right now' });
    let best = null, bd = Infinity;
    for (const q of Object.values(room.players)) {
      if (q.role !== 'runner' || q.tagged || !q.pos) continue;
      const d = dist(p.pos, q.pos);
      if (d < bd) { bd = d; best = q; }
    }
    if (!best || bd > CFG.TAG_RADIUS) return cb?.({ error: 'No runner within reach' });
    tag(room, best, p); push(room); cb?.({ ok: true, name: best.name });
  });

  sock.on('selfTag', () => {
    const p = me();
    if (p && p.role === 'runner' && room.phase === 'play') { tag(room, p, null); push(room); }
  });

  sock.on('restart', () => {
    if (!isHost() || room.phase !== 'over') return;
    room.phase = 'lobby';
    if (room.zone) room.zone.r = room.initialR;
    for (const p of Object.values(room.players)) Object.assign(p, { tagged: false, lastPing: null, live: false, outsideSince: null });
    push(room);
  });

  function drop(permanent) {
    const p = me(); if (!p) return;
    const r = room;
    p.online = false;
    const remove = () => {
      if (!r.players[p.id] || r.players[p.id].online) return;
      if (r.phase === 'lobby') delete r.players[p.id];
      if (r.hostId === p.id) {
        const next = humans(r).find(q => q.online);
        if (next) { r.hostId = next.id; log(r, `${next.name} is now the host`); }
      }
      push(r);
    };
    if (permanent) remove(); else setTimeout(remove, 30000);
  }

  sock.on('leave', () => { drop(true); if (room) sock.leave(room.code); room = null; pid = null; });
  sock.on('disconnect', () => drop(false));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pursuit running on http://localhost:${PORT}`));
