// Pursuit — browser client
(() => {
  const $ = id => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // ---------- identity ----------
  // Per-tab identity: sessionStorage survives a refresh but isn't shared between tabs,
  // so every tab/phone is its own player.
  const tab = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
    del(k) { try { sessionStorage.removeItem(k); } catch {} },
  };
  let pid = tab.get('pursuit.pid');
  if (!pid) { pid = 'p-' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36); tab.set('pursuit.pid', pid); }
  $('nameInput').value = store.get('pursuit.name') || '';
  const urlCode = new URLSearchParams(location.search).get('code');
  if (urlCode) $('codeInput').value = urlCode.toUpperCase();

  const socket = io({ transports: ['websocket'], upgrade: false });
  let S = null;             // latest state from server
  let clockSkew = 0;        // serverNow - clientNow
  let lastLogId = 0;
  let firstState = true;
  const now = () => Date.now() + clockSkew;

  // ---------- helpers ----------
  const fmt = msLeft => {
    const s = Math.max(0, Math.ceil(msLeft / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const ago = t => {
    const s = Math.max(0, Math.round((now() - t) / 1000));
    if (s < 15) return 'just now';
    if (s < 60) return `${Math.floor(s / 10) * 10}s ago`;
    return `${Math.floor(s / 60)} min ago`;
  };
  function toast(text, red) {
    const el = document.createElement('div');
    el.className = 'toast' + (red ? ' red' : '');
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 3500);
    while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  }
  const buzz = p => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function distM(a, b) {
    const r = d => d * Math.PI / 180, R = 6371000;
    const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // ---------- map ----------
  const map = L.map('map', { zoomControl: false, attributionControl: true, preferCanvas: true, fadeAnimation: false, markerZoomAnimation: true }).setView([9.9312, 76.2673], 16); // Kochi default
  // Tile sources in order of preference. If one fails (bad/missing key, blocked), fall back to the next.
  const mtKey = (window.PURSUIT_CONFIG || {}).maptilerKey;
  const SOURCES = [];
  if (mtKey) SOURCES.push({ url: `https://api.maptiler.com/maps/dataviz/256/{z}/{x}/{y}.png?key=${encodeURIComponent(mtKey)}`,
    opts: { maxZoom: 20, attribution: '&copy; MapTiler &copy; OpenStreetMap contributors' } });
  SOURCES.push({ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    opts: { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' } });
  SOURCES.push({ url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    opts: { maxZoom: 20, subdomains: 'abcd', attribution: '&copy; OpenStreetMap &copy; CARTO' } });
  let tileIdx = 0, tileLayer = null;
  function useTiles(i) {
    if (tileLayer) map.removeLayer(tileLayer);
    tileIdx = i;
    let errors = 0, loaded = 0;
    tileLayer = L.tileLayer(SOURCES[i].url, { ...SOURCES[i].opts, updateWhenIdle: true, keepBuffer: 1 }).addTo(map);
    tileLayer.on('tileload', () => loaded++);
    tileLayer.on('tileerror', () => {
      errors++;
      if (errors >= 3 && loaded === 0 && tileIdx === i && i + 1 < SOURCES.length) {
        console.warn('Map tiles failed, switching source');
        useTiles(i + 1);
      }
    });
  }
  useTiles(0);
  const zoneCircle = L.circle([0, 0], { radius: 1, color: '#e8321f', weight: 3, fill: true, fillColor: '#e8321f', fillOpacity: 0.04, interactive: false });
  const tagCircle = L.circle([0, 0], { radius: 25, color: '#e8321f', weight: 1, dashArray: '4 6', fillOpacity: 0.06, interactive: false });
  const markers = new Map();
  let centred = false;

  function icon(cls, label, sub, subRed) {
    return L.divIcon({
      className: '', iconSize: [0, 0],
      html: `<div class="mk ${cls}"><div class="dot"></div><div class="pill">${esc(label)}${sub ? `<em class="${subRed ? 'red' : ''}">${esc(sub)}</em>` : ''}</div></div>`,
    });
  }
  function setMarker(key, pos, cls, label, sub, subRed, z = 0) {
    const html = cls + '|' + label + '|' + sub + '|' + subRed;
    let m = markers.get(key);
    if (!m) {
      m = L.marker([pos.lat, pos.lng], { icon: icon(cls, label, sub, subRed), interactive: false, zIndexOffset: z }).addTo(map);
      m._sig = html; markers.set(key, m);
    } else {
      m.setLatLng([pos.lat, pos.lng]);
      if (m._sig !== html) { m.setIcon(icon(cls, label, sub, subRed)); m._sig = html; }
    }
    m._seen = true;
  }

  // ---------- location (GPS or simulated) ----------
  let myPos = null, gpsWatch = null, simTarget = null, lastGpsSend = 0;
  function sendLoc() { if (myPos && S) socket.emit('loc', myPos); }
  function startGPS() {
    if (!navigator.geolocation) { toast('GPS not available here — tap the map to move'); return; }
    if (gpsWatch !== null) { navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; updateGpsBtns(); toast('GPS off — tap the map to move'); return; }
    gpsWatch = navigator.geolocation.watchPosition(p => {
      myPos = { lat: p.coords.latitude, lng: p.coords.longitude };
      simTarget = null;
      if (Date.now() - lastGpsSend < 1000) { render(); return; }
      lastGpsSend = Date.now();
      if (!centred) { map.setView([myPos.lat, myPos.lng], 17); centred = true; }
      sendLoc(); render();
    }, err => {
      toast(err.code === 1 ? 'Location permission denied — tap the map to move' : 'Couldn’t get GPS — tap the map to move', true);
      if (gpsWatch !== null) navigator.geolocation.clearWatch(gpsWatch);
      gpsWatch = null; updateGpsBtns();
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    updateGpsBtns();
  }
  function updateGpsBtns() {
    for (const id of ['locBtn', 'locBtnLobby']) {
      $(id).classList.toggle('on', gpsWatch !== null);
      $(id).textContent = gpsWatch !== null ? '📍 GPS on' : '📍 Use GPS';
    }
  }
  $('locBtn').onclick = startGPS;
  $('locBtnLobby').onclick = startGPS;
  $('recenterBtn').onclick = () => { if (myPos) map.setView([myPos.lat, myPos.lng], Math.max(map.getZoom(), 17)); };

  // simulated walking toward a tapped point (desktop testing / no GPS)
  setInterval(() => {
    if (!simTarget || !myPos || !S) return;
    const me = S.players.find(p => p.self);
    if (me && me.tagged && S.phase === 'play') { simTarget = null; return; }
    const step = 4 * (S.speed || 1) * 0.25; // ~4 m/s, tick every 250ms
    const d = distM(myPos, simTarget);
    if (d <= step) { myPos = { ...simTarget }; simTarget = null; }
    else { const f = step / d; myPos = { lat: myPos.lat + (simTarget.lat - myPos.lat) * f, lng: myPos.lng + (simTarget.lng - myPos.lng) * f }; }
    render();
    const t = Date.now(); if (t - lastSimSend >= 1000) { lastSimSend = t; sendLoc(); }
  }, 250);
  let lastSimSend = 0;

  let tapMode = 'zone';
  map.on('click', e => {
    if (!S) return;
    const ll = { lat: e.latlng.lat, lng: e.latlng.lng };
    const isHost = S.hostId === S.me;
    if (S.phase === 'lobby' && isHost && tapMode === 'zone') {
      socket.emit('zone', { ...ll, r: Number($('radius').value) });
      if (!myPos) { myPos = ll; sendLoc(); }
      return;
    }
    if (gpsWatch !== null) return; // real GPS drives movement
    if (S.phase === 'lobby' || S.phase === 'over' || !myPos) { myPos = ll; simTarget = null; sendLoc(); render(); }
    else simTarget = ll;
  });

  // ---------- home ----------
  function name() { const n = $('nameInput').value.trim() || 'Player'; store.set('pursuit.name', n); return n; }
  $('createBtn').onclick = () => socket.emit('create', { name: name(), pid }, res => {
    if (res?.error) return ($('homeErr').textContent = res.error);
    tab.set('pursuit.room', res.code);
    if (!store.get('pursuit.seenIntro')) openIntro();
  });
  $('joinBtn').onclick = () => {
    const code = $('codeInput').value.trim().toUpperCase();
    if (code.length !== 4) return ($('homeErr').textContent = 'Enter the 4-letter code');
    socket.emit('join', { code, name: name(), pid }, res => {
      if (res?.error) return ($('homeErr').textContent = res.error);
      tab.set('pursuit.room', res.code);
      if (!store.get('pursuit.seenIntro')) openIntro();
    });
  };
  $('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });
  $('howBtn').onclick = openIntro;

  // reconnect to a room after refresh
  socket.on('connect', () => {
    const code = tab.get('pursuit.room');
    if (code) socket.emit('join', { code, name: name(), pid }, res => { if (res?.error) { tab.del('pursuit.room'); showHome(); } });
  });

  // ---------- lobby controls ----------
  $('roleSeg').onclick = e => { const r = e.target.dataset.role; if (r) socket.emit('role', r); };
  $('tapSeg').onclick = e => { const t = e.target.dataset.tap; if (t) { tapMode = t; render(); } };
  $('radius').oninput = () => {
    txt('radiusVal', $('radius').value + ' m');
    if (S?.zone) socket.emit('zone', { lat: S.zone.lat, lng: S.zone.lng, r: Number($('radius').value) });
  };
  $('botRunner').onclick = () => socket.emit('addBot', 'runner', r => r?.error && toast(r.error, true));
  $('botHunter').onclick = () => socket.emit('addBot', 'hunter', r => r?.error && toast(r.error, true));
  $('clearBots').onclick = () => socket.emit('clearBots');
  $('demoSpeed').onchange = () => socket.emit('speed', $('demoSpeed').checked ? 6 : 1);
  $('startBtn').onclick = () => socket.emit('start', r => r?.error && toast(r.error, true));
  $('shareBtn').onclick = async () => {
    const url = `${location.origin}${location.pathname}?code=${S.code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Join my Pursuit game', text: `Code ${S.code}`, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied'); }
    } catch {}
  };
  const leave = () => { socket.emit('leave'); tab.del('pursuit.room'); S = null; showHome(); };
  $('leaveBtn').onclick = leave; $('leaveBtn2').onclick = leave;
  $('againBtn').onclick = () => socket.emit('restart');

  $('actionBtn').onclick = () => {
    const me = S?.players.find(p => p.self); if (!me) return;
    if (me.role === 'hunter') {
      socket.emit('tag', r => { if (r?.error) toast(r.error, true); else { buzz([60, 40, 60]); } });
    } else if (!me.tagged && confirm('Did a hunter catch you? This can’t be undone.')) socket.emit('selfTag');
  };

  // ---------- state ----------
  socket.on('state', st => {
    clockSkew = st.now - Date.now();
    const prevPhase = S?.phase;
    S = st;
    if (firstState) { lastLogId = st.log.length ? st.log[st.log.length - 1].id : 0; firstState = false; }
    for (const e of st.log) if (e.id > lastLogId) {
      lastLogId = e.id;
      const red = /Ping|tagged|live|shrank|hunt is on/i.test(e.text);
      toast(e.text, red);
      if (/Ping/.test(e.text)) buzz(200);
      if (/hunt is on/.test(e.text)) buzz([100, 80, 100, 80, 300]);
    }
    if (prevPhase !== st.phase && st.zone && (st.phase === 'headstart')) map.fitBounds(zoneCircle.setLatLng([st.zone.lat, st.zone.lng]).setRadius(st.zone.r).getBounds(), { padding: [30, 30] });
    if (!myPos) { const me = st.players.find(p => p.self); if (me?.pos) myPos = me.pos; }
    if (!centred && st.zone) { map.setView([st.zone.lat, st.zone.lng], 16); centred = true; }
    if (st.zone && st.phase === 'lobby') $('radius').value = st.zone.r;
    render();
  });

  function showHome() {
    $('home').classList.remove('hidden');
    for (const id of ['lobby', 'hud', 'controls', 'over', 'holdOverlay']) $(id).classList.add('hidden');
    for (const m of markers.values()) m.remove();
    markers.clear(); zoneCircle.remove(); tagCircle.remove();
    firstState = true;
  }

  // ---------- render ----------
  const txt = (id, v) => { const el = $(id); if (el.textContent !== v) el.textContent = v; };
  const show = (id, on) => { const el = $(id); if (el.classList.contains('hidden') === on) el.classList.toggle('hidden', !on); };
  let renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; doRender(); });
  }
  function doRender() {
    if (!S) return;
    const me = S.players.find(p => p.self);
    if (!me) return;
    const isHost = S.hostId === S.me;
    const playing = S.phase === 'headstart' || S.phase === 'play';
    $('home').classList.add('hidden');
    show('lobby', S.phase === 'lobby');
    show('hud', playing);
    show('controls', playing);
    show('over', S.phase === 'over');
    show('holdOverlay', S.phase === 'headstart' && me.role === 'hunter');

    // zone
    if (S.zone) {
      zoneCircle.setLatLng([S.zone.lat, S.zone.lng]).setRadius(S.zone.r);
      if (!map.hasLayer(zoneCircle)) zoneCircle.addTo(map);
    } else zoneCircle.remove();

    // markers
    for (const m of markers.values()) m._seen = false;
    const hunterView = me.role === 'hunter' && playing;
    for (const p of S.players) {
      if (p.self) continue;
      const left = false;
      if (p.tagged && p.pos) { setMarker(p.id, p.pos, 'tagged' + (left ? ' left' : ''), p.name, 'tagged'); continue; }
      if (p.live && p.pos) { setMarker(p.id, p.pos, 'live', p.name, 'live · outside zone', true, 500); continue; }
      if (p.pos) {
        setMarker(p.id, p.pos, p.role === 'hunter' ? 'hunter' : '', p.name + (p.bot ? ' 🤖' : ''), playing ? '' : (p.role === 'hunter' ? 'hunter' : ''), false, p.role === 'hunter' ? 300 : 100);
        continue;
      }
      if (hunterView && p.ghost) setMarker(p.id, p.ghost, 'ghost', p.name, ago(p.ghost.t));
    }
    // me
    const myShown = (S.phase === 'play' && me.tagged) ? me.pos : (myPos || me.pos);
    if (myShown) {
      let cls = me.role === 'hunter' ? 'hunter' : '';
      let sub = '';
      if (me.role === 'runner' && S.phase === 'play') {
        if (me.tagged) { cls = 'tagged'; sub = 'tagged'; }
        else if (me.live) { cls = 'live'; sub = 'live · hunters see you'; }
        else { cls = 'selfreal'; sub = 'only you see this'; }
      }
      setMarker('me', myShown, cls, 'You', sub, me.live, 1000);
      if (me.role === 'hunter' && S.phase === 'play') {
        tagCircle.setLatLng([myShown.lat, myShown.lng]).setRadius(S.cfg.tagRadius);
        if (!map.hasLayer(tagCircle)) tagCircle.addTo(map);
      } else tagCircle.remove();
    }
    if (me.role === 'runner' && S.phase === 'play' && me.ghost && !me.tagged) setMarker('meGhost', me.ghost, 'ghost', 'You', ago(me.ghost.t), false, 900);
    for (const [k, m] of markers) if (!m._seen) { m.remove(); markers.delete(k); }

    if (S.phase === 'lobby') renderLobby(me, isHost);
    if (playing) renderHud(me);
    if (S.phase === 'over') renderOver(me, isHost);
  }

  function renderLobby(me, isHost) {
    txt('lobbyCode', S.code);
    $('roleSeg').dataset.roleOn = me.role;
    for (const b of $('roleSeg').children) b.classList.toggle('on', b.dataset.role === me.role);
    for (const b of $('tapSeg').children) b.classList.toggle('on', b.dataset.tap === tapMode);
    $('hostBox').classList.toggle('hidden', !isHost);
    $('startBtn').classList.toggle('hidden', !isHost);
    $('waitTxt').classList.toggle('hidden', isHost);
    $('demoSpeed').checked = S.speed === 6;
    txt('radiusVal', (S.zone ? S.zone.r : $('radius').value) + ' m');
    txt('zoneHint', S.zone ? 'Zone set. Tap the map to move it, or drag the slider to resize.' : 'Tap the map to place the zone’s centre.');
    const ps = S.players;
    const nR = ps.filter(p => p.role === 'runner').length, nH = ps.length - nR;
    txt('playersHead', `PLAYERS · ${ps.length}  (${nR} runner${nR === 1 ? '' : 's'}, ${nH} hunter${nH === 1 ? '' : 's'})`);
    $('startBtn').disabled = !(S.zone && ps.some(p => p.role === 'runner') && ps.some(p => p.role === 'hunter'));
    const listHtml = ps.map(p => `
      <li class="${p.online ? '' : 'off'}">
        <span class="pd ${p.role}"></span>${esc(p.name)}
        ${p.self ? '<span class="badge">you</span>' : ''}
        ${p.id === S.hostId ? '<span class="badge">host</span>' : ''}
        ${p.bot ? '<span class="badge">bot</span>' : ''}
        <span class="role">${p.role}</span>
      </li>`).join('');
    if ($('playerList')._html !== listHtml) { $('playerList').innerHTML = listHtml; $('playerList')._html = listHtml; }
  }

  function renderHud(me) {
    const t = now(), T = S.times;
    txt('roleBadge', me.role === 'hunter' ? 'HUNTER' : (me.tagged ? 'TAGGED' : 'RUNNER'));
    $('roleBadge').className = 'tagpill' + (me.role === 'hunter' ? ' hunter' : '');
    const act = $('actionBtn');
    if (me.role === 'hunter') {
      act.className = 'action'; act.textContent = 'TAG'; act.disabled = S.phase !== 'play';
    } else {
      act.className = 'action runner'; act.textContent = me.tagged ? 'CAUGHT' : 'I WAS TAGGED'; act.disabled = me.tagged || S.phase !== 'play';
    }

    if (S.phase === 'headstart') {
      txt('hudLabel', 'Head start');
      txt('hudBig', fmt(T.huntStart - t));
      txt('pingTxt', '—');
      $('pingBar').style.transform = 'scaleX(0)';
      txt('hudSub', me.role === 'hunter' ? 'Hold tight — runners are hiding' : 'Scatter and hide!');
      txt('shrinkTxt', '');
      txt('holdTime', fmt(T.huntStart - t));
      $('outsideWarn').classList.add('hidden');
      return;
    }
    txt('hudLabel', 'Time left');
    txt('hudBig', fmt(T.endAt - t));
    const toPing = T.nextPingAt - t;
    txt('pingTxt', fmt(toPing));
    $('pingBar').style.transform = `scaleX(${Math.min(1, Math.max(0, 1 - toPing / S.cfg.ping)).toFixed(3)})`;
    txt('hudSub', 'Hunters see every runner');
    txt('shrinkTxt', 'Zone shrinks in ' + fmt(T.nextShrinkAt - t));

    const w = $('outsideWarn');
    if (me.role === 'runner' && !me.tagged && me.outsideSince) {
      w.classList.remove('hidden');
      w.textContent = me.live ? 'You’re outside the zone — hunters can see you LIVE!'
        : `Outside the zone! Live to hunters in ${fmt(me.outsideSince + S.cfg.outside - t)}`;
    } else w.classList.add('hidden');
  }

  function renderOver(me, isHost) {
    const hw = S.winner === 'hunters';
    const won = (hw && me.role === 'hunter') || (!hw && me.role === 'runner');
    $('overKicker').textContent = won ? 'YOU WIN' : 'GAME OVER';
    $('overTitle').textContent = hw ? 'Hunters caught everyone.' : 'Runners win.';
    const free = S.players.filter(p => p.role === 'runner' && !p.tagged).map(p => p.name);
    $('overSub').textContent = hw ? 'Every runner was tagged before time ran out.' : `Still free at the buzzer: ${free.join(', ') || '—'}`;
    $('againBtn').classList.toggle('hidden', !isHost);
    $('overWait').classList.toggle('hidden', isHost);
  }

  // live clocks + ghost "ago" labels
  setInterval(render, 1000);

  // ---------- intro (how to play) ----------
  const SLIDES = [
    { k: 'THE ZONE', t: 'The host draws the zone.', s: 'Everyone plays inside it, on real streets.' },
    { k: 'HEAD START', t: 'Runners get a 3-minute head start.', s: 'Hunters wait while the runners scatter and hide.' },
    { k: 'HIDDEN', t: 'Hunters can’t see the runners…', s: 'Runners never appear on the hunters’ map.' },
    { k: 'THE PING', t: '…until the ping.', s: 'Every 2 minutes, hunters see where every runner is.' },
    { k: 'GHOSTS', t: 'But only where you were.', s: 'Keep moving after a ping and they’re chasing a ghost.' },
    { k: 'THE SQUEEZE', t: 'The zone shrinks every 5 minutes.', s: 'Spend 30 seconds outside it and hunters see you live.' },
    { k: 'TAG', t: 'Tag them for real.', s: 'Hunters win by catching everyone. Runners win if anyone is still free when time runs out.' },
  ];
  // entity positions per slide: [x, y, kind, sub] or null (hidden). kinds: runner, hunter, ghost, selfreal, live, tagged
  const ENTS = {
    Maya:  [null, [120, 250, 'runner'], null, [120, 250, 'ghost', 'just now'], [120, 250, 'ghost', '1 min ago'], null, null],
    Kai:   [null, [280, 250, 'runner'], null, [280, 250, 'ghost', 'just now'], [280, 250, 'ghost', '1 min ago'], [292, 230, 'live', 'live · outside'], [292, 230, 'tagged', 'tagged']],
    Priya: [null, [120, 420, 'runner'], null, [120, 420, 'ghost', 'just now'], [120, 420, 'ghost', '1 min ago'], null, null],
    You:   [null, [230, 400, 'runner'], null, [230, 400, 'ghost', 'just now'], [230, 400, 'ghost', '1 min ago'], [190, 448, 'selfreal', 'only you'], [190, 448, 'selfreal', '']],
    You2:  [null, null, null, null, [175, 462, 'selfreal', 'only you see this'], null, null],
    Sam:   [null, null, [170, 345, 'hunter'], [170, 345, 'hunter'], [215, 375, 'hunter', 'nobody here'], [220, 390, 'hunter'], [282, 248, 'hunter']],
    Jo:    [null, null, [185, 362, 'hunter'], [185, 362, 'hunter'], [150, 330, 'hunter'], [175, 360, 'hunter'], [165, 400, 'hunter']],
  };
  const ZONES = [[180, 340, 150], [180, 340, 150], [180, 340, 150], [180, 340, 150], [180, 340, 150], [175, 350, 110], [175, 350, 110]];
  const COLORS = { runner: '#141414', hunter: '#e8321f', ghost: '#fff', selfreal: '#5a5a5a', live: '#141414', tagged: '#eee' };
  let slide = 0;

  function buildArt() {
    const svg = $('introArt');
    let h = '<rect width="360" height="560" fill="#cfccc6"/>';
    // seeded pseudo-random so the city looks the same every time
    let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const tones = ['#ece8e1', '#e3ddd2', '#d9dde3', '#e7e4de', '#d8d2c6'];
    for (let y = -10; y < 560; y += 62) for (let x = -10; x < 360; x += 62) {
      const inPark = x > 110 && x < 240 && y > 280 && y < 440;
      if (inPark) continue;
      if (y > 448 && y < 490) continue; // rail corridor
      const n = rnd() > .55 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const w = n === 2 ? 22 : 46, bx = x + 4 + i * 25;
        const col = tones[Math.floor(rnd() * tones.length)];
        h += `<rect x="${bx + 2}" y="${y + 6}" width="${w}" height="46" rx="3" fill="#b9b4ab"/>`;
        h += `<rect x="${bx}" y="${y + 2}" width="${w}" height="46" rx="3" fill="${col}"/>`;
        h += `<rect x="${bx + w / 2 - 4}" y="${y + 14}" width="8" height="8" fill="#c9c4bb"/>`;
        if (rnd() > .7) h += `<circle cx="${bx + w - 6}" cy="${y + 44}" r="5" fill="#9aa592"/>`;
      }
    }
    // park
    h += '<rect x="112" y="282" width="126" height="156" rx="4" fill="#ddd3c0"/>';
    for (let i = 0; i < 22; i++) h += `<circle cx="${120 + rnd() * 110}" cy="${290 + rnd() * 140}" r="${5 + rnd() * 5}" fill="${rnd() > .5 ? '#8f9c86' : '#a4ae98'}"/>`;
    // rail
    h += '<rect x="0" y="452" width="360" height="32" fill="#b19c86"/>';
    for (let x = 0; x < 360; x += 6) h += `<rect x="${x}" y="456" width="2" height="24" fill="#8f7a64"/>`;
    h += '<rect x="0" y="462" width="360" height="2" fill="#6e5e4d"/><rect x="0" y="472" width="360" height="2" fill="#6e5e4d"/>';
    h += '<circle id="introZone" cx="180" cy="340" r="150" fill="rgba(232,50,31,.04)" stroke="#e8321f" stroke-width="2.5"/>';
    for (const name of Object.keys(ENTS)) {
      const label = name === 'You2' ? 'You' : name;
      h += `<g class="ent" id="ent-${name}" style="opacity:0">
        <circle class="ed" r="8" stroke="#fff" stroke-width="2.5" fill="#141414"/>
        <rect class="ep" x="12" y="-11" rx="11" height="22" width="60" fill="#fff"/>
        <text x="21" y="4" font-family="Inter, sans-serif" font-size="11" font-weight="700" fill="#141414"><tspan>${label}</tspan><tspan class="es" font-weight="500" fill="#777" dx="4"></tspan></text>
      </g>`;
    }
    svg.innerHTML = h;
    $('introProg').innerHTML = SLIDES.map(() => '<span></span>').join('');
  }

  function showSlide(i) {
    slide = i;
    const sd = SLIDES[i];
    $('introKicker').textContent = sd.k;
    $('introTitle').textContent = sd.t;
    $('introSub').textContent = sd.s;
    [...$('introProg').children].forEach((el, j) => el.classList.toggle('done', j <= i));
    const z = ZONES[i], zc = $('introZone');
    zc.setAttribute('cx', z[0]); zc.setAttribute('cy', z[1]); zc.setAttribute('r', z[2]);
    for (const [name, states] of Object.entries(ENTS)) {
      const g = $('ent-' + name), st = states[i];
      if (!st) { g.style.opacity = 0; continue; }
      const [x, y, kind, sub] = st;
      g.style.opacity = 1;
      g.style.transform = `translate(${x}px, ${y}px)`;
      const dot = g.querySelector('.ed');
      dot.setAttribute('fill', COLORS[kind]);
      dot.setAttribute('stroke', kind === 'ghost' ? '#141414' : kind === 'tagged' ? '#888' : '#fff');
      dot.setAttribute('stroke-dasharray', kind === 'tagged' ? '3 3' : '');
      const es = g.querySelector('.es');
      es.textContent = sub || '';
      es.setAttribute('fill', kind === 'live' ? '#e8321f' : '#777');
      const label = name === 'You2' ? 'You' : name;
      g.querySelector('.ep').setAttribute('width', 20 + label.length * 7 + (sub ? 6 + sub.length * 5.6 : 0));
    }
  }
  function openIntro() { if (!$('introArt').childNodes.length) buildArt(); $('intro').classList.remove('hidden'); showSlide(0); }
  function closeIntro() { $('intro').classList.add('hidden'); store.set('pursuit.seenIntro', '1'); }
  $('intro').addEventListener('click', e => {
    if (e.target.id === 'introSkip') return closeIntro();
    if (slide < SLIDES.length - 1) showSlide(slide + 1); else closeIntro();
  });
})();
