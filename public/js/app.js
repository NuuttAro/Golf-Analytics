import { store, uid, fmtD, unit, toUnit, fromUnit, CLUBS } from './store.js';
import { analyzeHole, roundSummary, holeScore, LIES, CATS, haversineYds } from './sg.js';
import { recommend, explain, answerLocally, aiContext, clubStats, roundsWithSummary, seasonAverages, shotLog, sgFmt } from './caddie.js';
import * as C from './course.js';
import * as cloudApi from './cloud.js';
const { cloud } = cloudApi;

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
const toParStr = n => n === 0 ? 'E' : (n > 0 ? '+' + n : '−' + Math.abs(n));
const LIE_LABEL = { tee: 'Tee', fairway: 'Fairway', rough: 'Rough', sand: 'Sand', recovery: 'Recovery', green: 'Green' };
const fmtDate = d => new Date(d + 'T12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const sgClass = v => v == null ? '' : v >= 0 ? 'pos' : 'neg';
const view = $('#view');
let aiOn = false;
fetch('/api/status').then(r => r.json()).then(j => { aiOn = !!j.ai; if (route() === 'caddie') renderCaddie(); }).catch(() => {});

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------------- routing ----------------
const route = () => (location.hash.slice(1).split('/')[0] || 'play');
let teardown = null;
function render() {
  if (teardown) { teardown(); teardown = null; }
  const r = route();
  const tab = { round: 'rounds', settings: 'rounds', friend: 'friends', fround: 'friends', account: 'friends' }[r] || r;
  document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  ({ play: renderPlay, stats: renderStats, caddie: renderCaddie, rounds: renderRounds, round: renderRoundDetail, settings: renderSettings,
     friends: renderFriends, friend: renderFriend, fround: renderFriendRound, account: renderAccount }[r] || renderPlay)();
  view.scrollTop = 0;
}
addEventListener('hashchange', render);

const isIosBrowser = () => /iP(hone|ad|od)/.test(navigator.userAgent) && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches;
function toggleUnits() { store.update(s => { s.profile.units = s.profile.units === 'm' ? 'yd' : 'm'; }); toast(store.get().profile.units === 'm' ? 'Distances in meters' : 'Distances in yards'); }

// ================= PLAY =================
const ui = { lie: 'tee', club: null, dist: null, distEdited: false, wind: 0, target: null, mode: 'target', search: [], busy: '' };

function renderPlay() {
  const round = store.activeRound();
  if (!round) return renderStart();
  C.startGps();
  const hole = round.holes[round.current - 1];
  const layout = store.get().courses[round.courseId]?.holes?.[hole.n];
  const played = round.holes.filter(h => h.holed);
  const toPar = played.reduce((a, h) => a + holeScore(h) - h.par, 0);
  view.innerHTML = `
    <section class="play">
      <header class="holebar">
        <button class="icon-btn" data-act="prev" aria-label="Previous hole">‹</button>
        <div class="holeinfo">
          <div class="eyebrow">${esc(round.course)}</div>
          <div class="holetitle">Hole ${hole.n} <span class="muted">·</span> <button class="par-btn" data-act="par">Par ${hole.par}</button>${hole.len ? ` <span class="muted">· ${fmtD(hole.len)}${unit()}</span>` : ''}</div>
        </div>
        <div class="topar"><div class="eyebrow">Score</div><div class="mono">${played.length ? toParStr(toPar) : '—'}</div></div>
        <button class="icon-btn" data-act="next" aria-label="Next hole">›</button>
      </header>
      <div class="mapwrap">
        <div id="map"></div>
        <div class="hud" id="hud"></div>
        <div class="maptools">
          <button class="chip ${ui.mode === 'sim' ? 'on' : ''}" data-act="mode" data-v="sim" title="Tap the map to set your position">Sim GPS</button>
          <button class="chip ${ui.mode === 'green' ? 'on' : ''}" data-act="mode" data-v="green" title="Tap the map to place this hole's green">${layout?.green ? 'Move green' : 'Set green'}</button>
          <button class="chip" data-act="units" title="Switch yards / meters">${unit() === 'm' ? 'Meters' : 'Yards'}</button>
          <button class="chip" data-act="fit">Fit</button>
        </div>
      </div>
      <div id="panel" class="panel"></div>
    </section>`;
  bindPlay(round);
  const m = C.createMap($('#map'));
  const stop = C.onLocation(() => { drawDynamic(m); updateHud(); if (!ui.distEdited) autoDist(); });
  drawHole(m, true);
  renderPanel();
  m.map.on('click', e => onMapTap(m, e.latlng));
  teardown = () => { stop(); try { m.map.stop(); m.map.off(); m.map.remove(); } catch { /* already gone */ } };
  ui.m = m;
}

function bindPlay(round) {
  view.onclick = e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, r = store.activeRound(); if (!r) return;
    const hole = r.holes[r.current - 1];
    if (act === 'prev' || act === 'next') {
      r.current = Math.min(r.holes.length, Math.max(1, r.current + (act === 'next' ? 1 : -1)));
      store.save(); resetShotUi(r); render();
    } else if (act === 'par') { hole.par = hole.par === 5 ? 3 : hole.par + 1; store.save(); render(); }
    else if (act === 'mode') { ui.mode = ui.mode === b.dataset.v ? 'target' : b.dataset.v; render(); toast(ui.mode === 'sim' ? 'Tap the map to set your position' : ui.mode === 'green' ? 'Tap the centre of the green' : 'Tap the map to measure'); }
    else if (act === 'fit') drawHole(ui.m, true);
    else if (act === 'units') { toggleUnits(); render(); }
    else if (act === 'lie') { ui.lie = b.dataset.v; if (ui.lie === 'green') ui.club = 'Putter'; else if (ui.club === 'Putter') ui.club = null; ui.distEdited = false; autoDist(); renderPanel(); }
    else if (act === 'club') { ui.club = b.dataset.v; renderPanel(); }
    else if (act === 'wind') { ui.wind = +b.dataset.v; renderPanel(); }
    else if (act === 'log') logShot(r, hole);
    else if (act === 'penalty') { const s = hole.shots[hole.shots.length - 1]; if (!s) return toast('Log the shot first'); s.penalty = !s.penalty; store.save(); renderPanel(); updateHeaderScore(); toast(s.penalty ? 'Penalty stroke added' : 'Penalty removed'); }
    else if (act === 'undo') { hole.shots.pop(); hole.holed = false; store.save(); resetShotUi(r); renderPanel(); }
    else if (act === 'holeout') {
      if (!hole.shots.length) return toast('Log at least one shot');
      hole.holed = true; if (!hole.len && hole.shots[0]) hole.len = hole.shots[0].dist;
      const s = holeScore(hole); toast(`Hole ${hole.n}: ${s} (${toParStr(s - hole.par)})`);
      if (r.current < r.holes.length) r.current++;
      store.save(); resetShotUi(r); render();
    } else if (act === 'reopen') { hole.holed = false; store.save(); resetShotUi(r); renderPanel(); }
    else if (act === 'finish') finishRound(r);
  };
  view.oninput = e => {
    if (e.target.id === 'dist') { const v = parseFloat(e.target.value); ui.dist = isNaN(v) ? null : (ui.lie === 'green' ? v : fromUnit(v)); ui.distEdited = true; renderCaddieLine(); }
  };
}

function updateHeaderScore() {
  const r = store.activeRound(); const el = $('.topar .mono'); if (!r || !el) return;
  const played = r.holes.filter(h => h.holed);
  el.textContent = played.length ? toParStr(played.reduce((a, h) => a + holeScore(h) - h.par, 0)) : '—';
}

function resetShotUi(r) {
  const hole = r.holes[r.current - 1];
  ui.club = null; ui.distEdited = false; ui.target = null; ui.dist = null;
  ui.lie = hole.shots.length ? guessLie(r, hole) : 'tee';
  if (ui.lie === 'green') ui.club = 'Putter';
}

function guessLie(r, hole) {
  const pos = C.current();
  const g = store.get().courses[r.courseId]?.holes?.[hole.n]?.green;
  if (pos && g?.poly && C.insidePoly(pos, g.poly)) return 'green';
  const last = hole.shots[hole.shots.length - 1];
  return last?.lie === 'green' ? 'green' : 'fairway';
}

function greenFor(r, hole) { return store.get().courses[r.courseId]?.holes?.[hole.n]?.green || null; }

function autoDist() {
  const r = store.activeRound(); if (!r) return;
  const hole = r.holes[r.current - 1];
  const pos = C.current(), g = greenFor(r, hole);
  let d = null;
  if (pos && g) d = haversineYds(pos, g.center);
  else if (!hole.shots.length && hole.len) d = hole.len;
  if (d != null) ui.dist = ui.lie === 'green' ? Math.round(d * 3) : d;
  const el = $('#dist');
  if (el && d != null) el.value = ui.lie === 'green' ? Math.round(ui.dist) : Math.round(toUnit(ui.dist));
  renderCaddieLine();
}

function renderPanel() {
  const r = store.activeRound(); const el = $('#panel'); if (!r || !el) return;
  const hole = r.holes[r.current - 1];
  const shots = analyzeHole(hole);
  const bag = store.get().profile.bag;
  const list = shots.length ? `<ol class="shotlist">${shots.map((s, i) => `
      <li><span class="mono n">${i + 1}</span><span class="club">${esc(s.club || '—')}</span><span class="muted">${LIE_LABEL[s.lie]} · ${s.lie === 'green' ? Math.round(s.dist) + 'ft' : fmtD(s.dist) + unit()}${s.penalty ? ' · +1 pen' : ''}</span><span class="sg mono ${sgClass(s.sg)}">${s.sg == null ? '' : sgFmt(s.sg)}</span></li>`).join('')}</ol>` : '';
  if (hole.holed) {
    const s = holeScore(hole);
    const last = r.current === r.holes.length || r.holes.every(h => h.holed);
    el.innerHTML = `<div class="card done-card"><div class="eyebrow">Hole complete</div><div class="big">${s} <span class="muted">(${toParStr(s - hole.par)})</span></div>${list}
      <div class="row"><button class="btn ghost" data-act="reopen">Edit hole</button>${last ? '<button class="btn primary" data-act="finish">Finish round</button>' : '<button class="btn primary" data-act="next">Next hole</button>'}</div></div>`;
    return;
  }
  if (ui.dist == null && !ui.distEdited) autoDist();
  const dv = ui.dist == null ? '' : ui.lie === 'green' ? Math.round(ui.dist) : Math.round(toUnit(ui.dist));
  el.innerHTML = `
    <div class="shot-head"><div class="eyebrow">Shot ${hole.shots.length + 1}</div>
      <label class="distfield"><input id="dist" type="number" inputmode="numeric" value="${dv}" placeholder="—"><span>${ui.lie === 'green' ? 'ft to hole' : unit() + ' to pin'}</span></label></div>
    <div class="chips" role="group" aria-label="Lie">${LIES.map(l => `<button class="chip ${ui.lie === l ? 'on' : ''}" data-act="lie" data-v="${l}">${LIE_LABEL[l]}</button>`).join('')}</div>
    ${ui.lie !== 'green' ? `<div class="chips wind" role="group" aria-label="Wind"><span class="eyebrow">Wind</span>${[[-20, '↓20'], [-10, '↓10'], [0, 'Calm'], [10, '↑10'], [20, '↑20']].map(([v, l]) => `<button class="chip sm ${ui.wind === v ? 'on' : ''}" data-act="wind" data-v="${v}" title="${v > 0 ? 'Into' : v < 0 ? 'Helping' : 'Calm'} ${Math.abs(v) || ''} mph">${l}</button>`).join('')}</div>` : ''}
    <div id="caddieLine" class="caddie-line"></div>
    <div class="clubs">${bag.filter(c => ui.lie === 'green' ? c === 'Putter' : (c !== 'Putter' && (c !== 'Dr' || ui.lie === 'tee'))).map(c => `<button class="club-btn ${ui.club === c ? 'on' : ''}" data-act="club" data-v="${c}" data-club="${c}">${c}</button>`).join('')}</div>
    <div class="row actions">
      <button class="btn ghost sm" data-act="undo" ${hole.shots.length ? '' : 'disabled'}>Undo</button>
      <button class="btn ghost sm" data-act="penalty" ${hole.shots.length ? '' : 'disabled'}>+ Penalty</button>
      <button class="btn primary grow" data-act="log">Log shot</button>
    </div>
    ${hole.shots.length ? `<button class="btn outline full" data-act="holeout">Holed it ✓ <span class="muted">(last shot went in)</span></button>` : ''}
    ${list}`;
  renderCaddieLine();
}

function renderCaddieLine() {
  const el = $('#caddieLine'); if (!el) return;
  document.querySelectorAll('.club-btn.rec').forEach(b => b.classList.remove('rec'));
  if (ui.lie === 'green' || ui.dist == null) { el.innerHTML = ui.lie === 'green' ? '' : '<span class="muted">Enter a distance for a club suggestion.</span>'; return; }
  const rec = recommend({ target: ui.dist, lie: ui.lie, wind: ui.wind });
  rec.target = ui.dist;
  const p = rec.picks[0];
  el.innerHTML = `<span class="tag">CADDIE</span> ${md(explain(rec, ui.lie))}`;
  if (p) { const b = document.querySelector(`.club-btn[data-club="${p.club}"]`); if (b) b.classList.add('rec'); }
}

function logShot(r, hole) {
  if (ui.dist == null || isNaN(ui.dist) || ui.dist <= 0) return toast('Enter the distance first');
  if (!ui.club) { const p = ui.lie === 'green' ? null : recommend({ target: ui.dist, lie: ui.lie, wind: ui.wind }).picks[0]; ui.club = ui.lie === 'green' ? 'Putter' : p?.club; if (!ui.club) return toast('Pick a club'); }
  const pos = C.current();
  const shot = { lie: ui.lie, dist: Math.round(ui.dist * 10) / 10, club: ui.club, t: Date.now() };
  if (pos && (C.isSimulated() || (pos.acc ?? 99) < 40)) { shot.lat = pos.lat; shot.lng = pos.lng; }
  hole.shots.push(shot);
  store.save();
  const nextLie = ui.lie === 'green' ? 'green' : 'fairway';
  ui.club = nextLie === 'green' ? 'Putter' : null; ui.distEdited = false; ui.dist = null; ui.lie = nextLie;
  toast(`Shot ${hole.shots.length} logged — ${shot.club}`);
  renderPanel();
}

function finishRound(r) {
  r.done = true; store.get().active = null; store.save();
  location.hash = 'round/' + r.id;
}

// ---- map drawing ----
function drawHole(m, fit) {
  const r = store.activeRound(); if (!r || !m) return;
  const hole = r.holes[r.current - 1];
  const course = store.get().courses[r.courseId];
  const lay = course?.holes?.[hole.n];
  const { L } = m; m.layers.clearLayers();
  (course?.extra?.bunker || []).forEach(p => L.polygon(p, { color: '#d8d2b8', weight: 1, fillOpacity: 0.25 }).addTo(m.layers));
  if (lay?.line) L.polyline(lay.line, { color: '#ffffff', weight: 2, opacity: 0.6, dashArray: '4 6' }).addTo(m.layers);
  if (lay?.green?.poly) L.polygon(lay.green.poly, { color: '#ffffff', weight: 2, fillColor: '#ffffff', fillOpacity: 0.12 }).addTo(m.layers);
  if (lay?.green) L.circleMarker(lay.green.center, { radius: 5, color: '#0a0a0a', weight: 2, fillColor: '#ffffff', fillOpacity: 1 }).addTo(m.layers).bindTooltip('Pin', { direction: 'top' });
  if (lay?.tee) L.circleMarker(lay.tee, { radius: 5, color: '#ffffff', weight: 2, fillColor: '#6798ff', fillOpacity: 1 }).addTo(m.layers);
  hole.shots.forEach((s, i) => { if (s.lat != null) L.circleMarker([s.lat, s.lng], { radius: 4, color: '#6798ff', weight: 2, fillOpacity: 0.4 }).addTo(m.layers).bindTooltip(`${i + 1}: ${s.club}`); });
  if (fit) {
    const pts = [];
    if (lay?.tee) pts.push(lay.tee);
    if (lay?.green) pts.push(lay.green.center);
    if (lay?.line) pts.push(...lay.line);
    const pos = C.current();
    if (pos && lay?.green && haversineYds(pos, lay.green.center) < 650) pts.push(pos);
    if (pts.length >= 2) m.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 18 });
    else if (pts.length === 1) m.map.setView(pts[0], 17);
    else if (pos) m.map.setView(pos, 17);
    else if (course?.center) m.map.setView(course.center, 16);
  }
  drawDynamic(m); updateHud();
}

function drawDynamic(m) {
  const r = store.activeRound(); if (!r || !m) return;
  const hole = r.holes[r.current - 1];
  const g = greenFor(r, hole), pos = C.current(), { L } = m;
  m.dyn.clearLayers();
  if (pos) {
    if (pos.acc && !C.isSimulated()) L.circle(pos, { radius: pos.acc, color: '#6798ff', weight: 0, fillOpacity: 0.12 }).addTo(m.dyn);
    L.circleMarker(pos, { radius: 7, color: '#ffffff', weight: 2, fillColor: '#6798ff', fillOpacity: 1 }).addTo(m.dyn);
  }
  if (ui.target) {
    L.circleMarker(ui.target, { radius: 6, color: '#6798ff', weight: 2, fillColor: '#0a0a0a', fillOpacity: 1 }).addTo(m.dyn);
    const chain = [pos, ui.target, g?.center].filter(Boolean);
    if (chain.length >= 2) L.polyline(chain, { color: '#6798ff', weight: 2 }).addTo(m.dyn);
    const a = pos ? haversineYds(pos, ui.target) : null, b = g ? haversineYds(ui.target, g.center) : null;
    L.tooltip({ permanent: true, direction: 'right', className: 'maptip', offset: [10, 0] }).setLatLng(ui.target)
      .setContent(`${a != null ? fmtD(a) + unit() : ''}${a != null && b != null ? ' · ' : ''}${b != null ? fmtD(b) + unit() + ' to pin' : ''}`).addTo(m.dyn);
  } else if (pos && g) {
    L.polyline([pos, g.center], { color: '#6798ff', weight: 2, opacity: 0.8 }).addTo(m.dyn);
  }
}

function updateHud() {
  const r = store.activeRound(); const el = $('#hud'); if (!r || !el) return;
  const hole = r.holes[r.current - 1];
  const g = greenFor(r, hole), pos = C.current();
  const d = C.greenDistances(pos, g);
  if (!g) { el.innerHTML = `<div class="hud-note">No green mapped for this hole — tap <b>Set green</b>, or enter distances by hand.</div>`; return; }
  if (!pos) { el.innerHTML = `<div class="hud-note">Waiting for GPS… (or use <b>Sim GPS</b>)</div>`; return; }
  el.innerHTML = `<div class="fcb"><div><span class="eyebrow">Front</span><b>${fmtD(d.front)}</b></div><div class="c"><span class="eyebrow">Centre</span><b>${fmtD(d.center)}</b></div><div><span class="eyebrow">Back</span><b>${fmtD(d.back)}</b></div></div>
    ${pos.acc && !C.isSimulated() ? `<div class="acc mono">±${Math.round(toUnit(pos.acc * 1.094))}${unit()}</div>` : C.isSimulated() ? '<div class="acc mono">SIM</div>' : ''}`;
}

function onMapTap(m, ll) {
  const r = store.activeRound(); if (!r) return;
  const p = { lat: ll.lat, lng: ll.lng };
  if (ui.mode === 'sim') { C.simulate(p); if (!ui.distEdited) autoDist(); }
  else if (ui.mode === 'green') {
    const hole = r.holes[r.current - 1];
    store.update(s => {
      const c = (s.courses[r.courseId] ||= { name: r.course, holes: {} });
      const h = (c.holes[hole.n] ||= { n: hole.n });
      h.green = { center: p, poly: null };
    });
    ui.mode = 'target'; toast('Green saved for hole ' + hole.n); render(); return;
  } else { ui.target = ui.target ? null : p; }
  drawDynamic(m); updateHud();
}

// ---- start a round ----
function renderStart() {
  const st = store.get();
  const saved = Object.entries(st.courses).slice(-5).reverse();
  view.innerHTML = `
    <section class="page">
      <div class="hero grid-bg">
        <div class="eyebrow">Carry · Golf analytics</div>
        <h1>Ready to play?</h1>
        <p class="muted">GPS distances, shot tracking and strokes gained — with a caddie that learns your game.</p>
      </div>
      ${isIosBrowser() ? `<div class="card install"><svg viewBox="0 0 24 24"><path d="M12 3v12M8 7l4-4 4 4M5 12v8h14v-8"/></svg><div><b>Install on your iPhone</b><div class="muted sm">Tap the Share button in Safari, then <b>Add to Home Screen</b>. Carry then opens full-screen like an app.</div></div></div>` : ''}
      <div class="card">
        <div class="eyebrow">Find a course</div>
        <button class="btn primary full" data-act="near">${ui.busy === 'near' ? 'Locating…' : 'Courses near me'}</button>
        <form class="searchrow" data-form="search"><input name="q" placeholder="Search by name" autocomplete="off"><button class="btn outline">${ui.busy === 'search' ? '…' : 'Search'}</button></form>
        ${ui.search.length ? `<ul class="list">${ui.search.map((c, i) => `<li><button class="listbtn" data-act="pick" data-i="${i}"><span>${esc(c.name)}</span><span class="muted">${c.dist != null ? fmtD(c.dist) + unit() + ' away' : esc(c.sub || '')}</span></button></li>`).join('')}</ul>` : ''}
        ${ui.busy === 'load' ? '<p class="muted">Loading course layout from OpenStreetMap — can take up to a minute…</p>' : ''}
      </div>
      ${saved.length ? `<div class="card"><div class="eyebrow">Your courses</div><ul class="list">${saved.map(([id, c]) => `<li><button class="listbtn" data-act="saved" data-id="${esc(id)}"><span>${esc(c.name)}</span><span class="muted">${Object.values(c.holes || {}).filter(h => h.green).length} greens mapped</span></button></li>`).join('')}</ul></div>` : ''}
      <div class="card">
        <div class="eyebrow">Unmapped course</div>
        <form class="searchrow" data-form="manual"><input name="name" placeholder="Course name" required><select name="holes"><option>18</option><option>9</option></select><button class="btn outline">Start</button></form>
        <p class="muted sm">You can place each green on the map as you play — it's saved for next time.</p>
      </div>
    </section>`;
  view.onclick = async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'near') {
      ui.busy = 'near'; renderStart();
      try {
        const pos = C.current() || await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude }), rej, { enableHighAccuracy: true, timeout: 12000 }));
        ui.search = await C.findCoursesNear(pos);
        if (!ui.search.length) toast('No mapped courses within 8 km');
      } catch (err) { toast(err.message?.includes('busy') ? err.message : 'Location unavailable — try search'); }
      ui.busy = ''; renderStart();
    } else if (b.dataset.act === 'pick') {
      const c = ui.search[+b.dataset.i]; ui.busy = 'load'; renderStart();
      let layout = { holes: {}, feats: {} };
      try { layout = await C.loadCourseLayout(c); } catch (err) { toast('Layout unavailable — greens can be set by hand'); }
      store.update(s => { s.courses[c.osmId] = { name: c.name, center: { lat: c.lat, lng: c.lng }, holes: layout.holes, extra: { bunker: (layout.feats.bunker || []).slice(0, 150).map(f => f.pts) } }; });
      ui.busy = ''; ui.search = [];
      startRound(c.name, c.osmId);
    } else if (b.dataset.act === 'saved') { const id = b.dataset.id; startRound(store.get().courses[id].name, id); }
  };
  view.onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (e.target.dataset.form === 'search') {
      const q = String(f.get('q') || '').trim(); if (!q) return;
      ui.busy = 'search'; renderStart();
      try { ui.search = await C.searchCourses(q); if (!ui.search.length) toast('No courses found'); } catch { toast('Search unavailable'); }
      ui.busy = ''; renderStart();
    } else {
      const name = String(f.get('name')).trim(); const id = 'manual-' + name.toLowerCase().replace(/\W+/g, '-');
      store.update(s => { s.courses[id] ||= { name, holes: {}, holeCount: +f.get('holes') }; });
      startRound(name, id, +f.get('holes'));
    }
  };
}

function startRound(name, courseId, count) {
  const course = store.get().courses[courseId] || {};
  const n = count || course.holeCount || Math.max(18, ...Object.keys(course.holes || {}).map(Number).filter(x => x <= 18), 0);
  const lineLen = l => l ? l.slice(1).reduce((a, p, i) => a + haversineYds(l[i], p), 0) : null;
  const round = {
    id: uid(), date: new Date().toISOString().slice(0, 10), course: name, courseId, current: 1, done: false,
    holes: Array.from({ length: n }, (_, i) => { const h = course.holes?.[i + 1]; return { n: i + 1, par: h?.par || 4, len: h?.line ? Math.round(lineLen(h.line)) : null, shots: [], holed: false }; }),
  };
  store.update(s => { s.rounds.unshift(round); s.active = round.id; });
  resetShotUi(round);
  location.hash = 'play'; render();
}

// ================= STATS =================
let statFilter = String(new Date().getFullYear());
function filtered() {
  const all = roundsWithSummary();
  if (statFilter === 'all') return all;
  if (statFilter === 'last5') return all.slice(0, 5);
  return all.filter(x => x.r.date.startsWith(statFilter));
}

function renderStats() {
  const all = roundsWithSummary();
  const years = [...new Set(all.map(x => x.r.date.slice(0, 4)))].sort().reverse();
  const list = filtered();
  const a = seasonAverages(list);
  const maxAbs = Math.max(0.5, ...Object.values(a.sg).map(Math.abs));
  const stats = clubStats();
  const bag = store.get().profile.bag.filter(c => stats[c]);
  const maxClub = Math.max(...bag.map(c => stats[c].hi), 1);
  const best = list.length ? list.reduce((b, x) => x.s.score < b.s.score ? x : b) : null;
  const ids = new Set(list.map(x => x.r.id));
  const log = shotLog().filter(s => ids.has(s.round));
  const putts = [];
  for (const x of list) for (const h of x.r.holes) for (const s of analyzeHole(h)) if (s.lie === 'green') putts.push(s);

  const bucket = (arr, edges, key, fmt) => edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1]; const xs = arr.filter(s => s[key] >= lo && s[key] < hi && s.sg != null);
    return { label: fmt(lo, hi), n: xs.length, sg: xs.length ? xs.reduce((t, s) => t + s.sg, 0) / xs.length : null, make: xs.length ? xs.filter(s => s.nextLie === 'holed').length / xs.length : null };
  });
  const app = bucket(log.filter(s => s.cat === 'app'), [50, 100, 150, 200, 700], 'dist', (lo, hi) => hi > 600 ? `${fmtD(lo)}+` : `${fmtD(lo)}–${fmtD(hi)}`);
  const pb = bucket(putts, [0, 4, 8, 15, 25, 200], 'dist', (lo, hi) => hi > 100 ? `${lo}+ ft` : `${lo}–${hi} ft`);

  view.innerHTML = `
    <section class="page">
      <div class="titlerow"><h2 class="pagetitle">Stats</h2><button class="chip" data-units title="Switch yards / meters">${unit() === 'm' ? 'Meters' : 'Yards'}</button></div>
      <div class="chips">${[...years.map(y => [y, y]), ['last5', 'Last 5'], ['all', 'All']].map(([v, l]) => `<button class="chip ${statFilter === v ? 'on' : ''}" data-f="${v}">${l}</button>`).join('')}</div>
      ${!list.length ? '<div class="card"><p class="muted">No finished rounds in this period.</p></div>' : `
      <div class="statgrid">
        <div class="stat"><div class="eyebrow">Scoring avg</div><div class="v">${a.score.toFixed(1)}</div><div class="muted sm">${a.rounds} rounds</div></div>
        <div class="stat"><div class="eyebrow">Best</div><div class="v">${best.s.score}</div><div class="muted sm">${fmtDate(best.r.date)}</div></div>
        <div class="stat"><div class="eyebrow">Fairways</div><div class="v">${Math.round(a.fir * 100)}%</div></div>
        <div class="stat"><div class="eyebrow">GIR</div><div class="v">${Math.round(a.gir * 100)}%</div></div>
        <div class="stat"><div class="eyebrow">Putts / rd</div><div class="v">${a.putts.toFixed(1)}</div></div>
        <div class="stat"><div class="eyebrow">SG total</div><div class="v ${sgClass(a.sg.ott + a.sg.app + a.sg.arg + a.sg.putt)}">${sgFmt(a.sg.ott + a.sg.app + a.sg.arg + a.sg.putt)}</div></div>
      </div>
      <div class="card">
        <div class="eyebrow">Strokes gained per round <span class="muted">· vs tour baseline</span></div>
        <div class="sgbars">${Object.entries(CATS).map(([k, l]) => { const v = a.sg[k]; const w = Math.abs(v) / maxAbs * 50; return `
          <div class="sgrow"><span class="lbl">${l}</span><div class="track"><div class="zero"></div><div class="bar ${sgClass(v)}" style="${v >= 0 ? 'left:50%' : `left:${50 - w}%`};width:${w}%"></div></div><span class="mono val ${sgClass(v)}">${sgFmt(v)}</span></div>`; }).join('')}</div>
      </div>
      <div class="card"><div class="eyebrow">Trend · SG total by round</div>${trendSvg(list.slice(0, 16).reverse())}</div>
      <div class="card"><div class="eyebrow">Approach by distance</div>
        <table class="tbl"><thead><tr><th>From</th><th>Shots</th><th>SG / shot</th></tr></thead><tbody>${app.map(b => `<tr><td>${b.label}${unit()}</td><td class="mono">${b.n}</td><td class="mono ${sgClass(b.sg)}">${sgFmt(b.sg)}</td></tr>`).join('')}</tbody></table></div>
      <div class="card"><div class="eyebrow">Putting by distance</div>
        <table class="tbl"><thead><tr><th>Length</th><th>Putts</th><th>Made</th><th>SG / putt</th></tr></thead><tbody>${pb.map(b => `<tr><td>${b.label}</td><td class="mono">${b.n}</td><td class="mono">${b.make == null ? '—' : Math.round(b.make * 100) + '%'}</td><td class="mono ${sgClass(b.sg)}">${sgFmt(b.sg)}</td></tr>`).join('')}</tbody></table></div>`}
      <div class="card"><div class="eyebrow">Club distances <span class="muted">· learned from all logged shots</span></div>
        ${bag.length ? `<div class="gaps">${bag.map(c => { const s = stats[c]; return `<div class="gap"><span class="club mono">${c}</span><div class="gtrack"><div class="grange" style="left:${s.lo / maxClub * 100}%;width:${Math.max(1, (s.hi - s.lo) / maxClub * 100)}%"></div><div class="gmed" style="left:${s.median / maxClub * 100}%"></div></div><span class="mono v">${fmtD(s.median)}</span></div>`; }).join('')}</div><p class="muted sm">Bar = typical range (20th–80th pct), tick = median, in ${unit() === 'm' ? 'meters' : 'yards'}.</p>` : '<p class="muted">Log shots to learn your distances.</p>'}
      </div>
    </section>`;
  view.onclick = e => { const b = e.target.closest('[data-f]'); if (b) { statFilter = b.dataset.f; renderStats(); } if (e.target.closest('[data-units]')) { toggleUnits(); renderStats(); } };
}

function trendSvg(list) {
  if (!list.length) return '';
  const W = 340, H = 120, pad = 18, vals = list.map(x => x.s.sgTotal);
  const m = Math.max(2, ...vals.map(Math.abs));
  const bw = (W - pad * 2) / vals.length;
  const y = v => H / 2 - v / m * (H / 2 - 12);
  return `<svg viewBox="0 0 ${W} ${H}" class="trend" role="img" aria-label="Strokes gained trend">
    <line x1="${pad}" x2="${W - pad}" y1="${H / 2}" y2="${H / 2}" class="axis"/>
    ${vals.map((v, i) => `<rect x="${pad + i * bw + 2}" width="${Math.max(2, bw - 4)}" y="${Math.min(y(v), H / 2)}" height="${Math.max(1, Math.abs(y(v) - H / 2))}" rx="2" class="${v >= 0 ? 'pos' : 'neg'}"><title>${list[i].r.date}: ${list[i].s.score} (${sgFmt(v)})</title></rect>`).join('')}
    <text x="${pad}" y="10" class="lbl">+${m.toFixed(0)}</text><text x="${pad}" y="${H - 2}" class="lbl">−${m.toFixed(0)}</text>
  </svg>`;
}

// ================= CADDIE =================
const SUGGEST = ['What club goes 150?', 'Lowest round this year?', 'How far is my 7 iron?', 'Where am I losing strokes?', 'What should I hit from 130 in the rough?', 'My distances'];
function renderCaddie() {
  const chat = store.get().chat;
  view.innerHTML = `
    <section class="page caddie">
      <h2 class="pagetitle">Caddie <span class="tag">${aiOn ? 'AI · ON' : 'LOCAL'}</span></h2>
      <div class="chatlog" id="chatlog">
        ${chat.length ? '' : `<div class="card intro"><p>I learn from every shot you log: how far each club really goes for you, from which lie, and which clubs score best from where. Ask me anything about your game.</p></div>`}
        ${chat.map(m => `<div class="msg ${m.role}">${m.role === 'caddie' ? md(m.text) : esc(m.text)}${m.ai ? '<span class="src">AI</span>' : ''}</div>`).join('')}
      </div>
      <div class="chips suggest">${SUGGEST.map(s => `<button class="chip" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      <form class="ask" id="ask"><input name="q" placeholder="Ask your caddie…" autocomplete="off"><button class="btn primary">Ask</button></form>
      ${chat.length ? '<button class="linkbtn" data-act="clear">Clear conversation</button>' : ''}
    </section>`;
  const log = $('#chatlog'); log.scrollTop = log.scrollHeight;
  view.onclick = e => {
    const q = e.target.closest('[data-q]'); if (q) return ask(q.dataset.q);
    if (e.target.closest('[data-act="clear"]')) { store.update(s => { s.chat = []; }); renderCaddie(); }
  };
  view.onsubmit = e => { e.preventDefault(); const v = e.target.q.value.trim(); if (v) ask(v); };
}

async function ask(q) {
  const push = m => store.update(s => { s.chat.push(m); s.chat = s.chat.slice(-40); });
  const history = store.get().chat.slice(-6);
  push({ role: 'user', text: q });
  const local = answerLocally(q);
  if (local) { push({ role: 'caddie', text: local }); return renderCaddie(); }
  if (aiOn && cloud.enabled && !cloud.user) { push({ role: 'caddie', text: 'Sign in (Friends tab) to ask the AI caddie free-form questions. Club picks, distances and records work without an account.' }); return renderCaddie(); }
  if (!aiOn) { push({ role: 'caddie', text: "I can answer club distances, club picks (\"what club for 150 from the rough\"), best/worst rounds, scoring average, putts, fairways, GIR and strokes gained. Free-form questions need the AI caddie — start the server with a Claude API key." }); return renderCaddie(); }
  renderCaddie();
  $('#chatlog').insertAdjacentHTML('beforeend', '<div class="msg caddie thinking">Thinking…</div>');
  $('#chatlog').scrollTop = 1e9;
  try {
    const res = await fetch('/api/caddie', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cloud.token ? { Authorization: 'Bearer ' + cloud.token } : {}) }, body: JSON.stringify({ question: q, context: aiContext(), history }) });
    const j = await res.json();
    push({ role: 'caddie', text: j.answer || j.error || 'No answer.', ai: !!j.answer });
  } catch { push({ role: 'caddie', text: "Can't reach the caddie server — you may be offline." }); }
  if (route() === 'caddie') renderCaddie();
}

// ================= ROUNDS =================
function renderRounds() {
  const st = store.get();
  const rounds = st.rounds;
  view.innerHTML = `
    <section class="page">
      <div class="titlerow"><h2 class="pagetitle">Rounds</h2><a class="btn ghost sm" href="#settings">Settings</a></div>
      ${syncLine()}
      ${st.seeded && rounds.some(r => r.demo) ? `<div class="banner">Showing demo rounds so the stats and caddie have data. <button class="linkbtn" data-act="cleardemo">Remove demo data</button></div>` : ''}
      ${rounds.length ? `<ul class="rounds">${rounds.map(r => { const s = roundSummary(r); const fin = r.holes.every(h => h.holed);
        return `<li><a href="#${r.id === st.active ? 'play' : 'round/' + r.id}" class="roundrow"><div><div class="rname">${esc(r.course)}</div><div class="muted sm">${fmtDate(r.date)} ${r.date.slice(0, 4)} · ${s.holes}/${r.holes.length} holes${r.id === st.active ? ' · <span class="accent">in progress</span>' : ''}</div></div>
        <div class="rscore"><div class="v">${s.holes ? s.score : '—'}</div><div class="muted sm mono">${s.holes ? toParStr(s.toPar) : ''}</div></div><div class="mono sg ${sgClass(fin ? s.sgTotal : null)}">${fin ? sgFmt(s.sgTotal) : ''}</div></a></li>`; }).join('')}</ul>` : '<div class="card"><p class="muted">No rounds yet. Start one from the Play tab.</p></div>'}
    </section>`;
  view.onclick = e => { if (e.target.closest('[data-act="cleardemo"]')) { store.clearDemo(); renderRounds(); } };
}

function renderRoundDetail() {
  const id = location.hash.split('/')[1];
  const r = store.get().rounds.find(x => x.id === id);
  if (!r) { location.hash = 'rounds'; return; }
  renderRoundView(r, { back: '#rounds', backLabel: 'Rounds' });
}

function renderRoundView(r, { back, backLabel, owner = null }) {
  const own = !owner;
  const s = roundSummary(r);
  const half = (a, b) => r.holes.slice(a, b);
  const card = hs => `<table class="scorecard"><tr><th>Hole</th>${hs.map(h => `<td>${h.n}</td>`).join('')}<td><b>Tot</b></td></tr>
    <tr><th>Par</th>${hs.map(h => `<td class="muted">${h.par}</td>`).join('')}<td class="muted">${hs.reduce((a, h) => a + h.par, 0)}</td></tr>
    <tr><th>Score</th>${hs.map(h => { const sc = h.holed ? holeScore(h) : null; const d = sc == null ? null : sc - h.par; return `<td><span class="sc ${d == null ? '' : d < 0 ? 'birdie' : d > 1 ? 'dbl' : d > 0 ? 'bogey' : ''}">${sc ?? '·'}</span></td>`; }).join('')}<td><b>${hs.filter(h => h.holed).reduce((a, h) => a + holeScore(h), 0)}</b></td></tr></table>`;
  view.innerHTML = `
    <section class="page">
      <a href="${back}" class="back">‹ ${esc(backLabel)}</a>
      ${owner ? `<div class="eyebrow">@${esc(owner.username)}</div>` : ''}
      <h2 class="pagetitle">${esc(r.course)}</h2>
      <div class="muted">${new Date(r.date + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
      <div class="statgrid">
        <div class="stat"><div class="eyebrow">Score</div><div class="v">${s.score}</div><div class="muted sm mono">${toParStr(s.toPar)}</div></div>
        <div class="stat"><div class="eyebrow">Putts</div><div class="v">${s.putts}</div></div>
        <div class="stat"><div class="eyebrow">SG total</div><div class="v ${sgClass(s.sgTotal)}">${sgFmt(s.sgTotal)}</div></div>
      </div>
      <div class="card scroll-x">${card(half(0, 9))}${r.holes.length > 9 ? card(half(9, 18)) : ''}</div>
      <div class="card"><div class="eyebrow">Strokes gained</div><div class="sgsplit">${Object.entries(CATS).map(([k, l]) => `<div><div class="muted sm">${l}</div><div class="mono v ${sgClass(s.sg[k])}">${sgFmt(s.sg[k])}</div></div>`).join('')}</div>
        <div class="muted sm" style="margin-top:12px">Fairways ${s.fir}/${s.firN} · GIR ${s.gir}/${s.girN} · Penalties ${s.penalties}</div></div>
      <div class="card"><div class="eyebrow">Shot by shot</div>${r.holes.filter(h => h.shots.length).map(h => `<details><summary><span>Hole ${h.n} · Par ${h.par}</span><span class="mono">${h.holed ? holeScore(h) : '…'}</span></summary><ol class="shotlist">${analyzeHole(h).map((x, i) => `<li><span class="mono n">${i + 1}</span><span class="club">${esc(x.club)}</span><span class="muted">${LIE_LABEL[x.lie]} · ${x.lie === 'green' ? Math.round(x.dist) + 'ft' : fmtD(x.dist) + unit()}${x.penalty ? ' · +1' : ''}</span><span class="sg mono ${sgClass(x.sg)}">${sgFmt(x.sg)}</span></li>`).join('')}</ol></details>`).join('')}</div>
      ${own && cloud.user && !r.demo ? `<div class="card"><div class="eyebrow">Sharing</div><div class="chips">${[['friends', 'Friends can see'], ['private', 'Only me']].map(([v, l]) => `<button class="chip ${(r.visibility || 'friends') === v ? 'on' : ''}" data-vis="${v}">${l}</button>`).join('')}</div></div>` : ''}
      ${own ? `<div class="row">${!r.done ? '<button class="btn primary" data-act="resume">Resume round</button>' : ''}<button class="btn ghost" data-act="delete">Delete round</button></div>` : ''}
    </section>`;
  view.onclick = e => {
    const v = e.target.closest('[data-vis]');
    if (v && own) { store.update(() => { r.visibility = v.dataset.vis; }); renderRoundView(r, { back, backLabel }); return; }
    const b = e.target.closest('[data-act]'); if (!b || !own) return;
    if (b.dataset.act === 'delete' && confirm('Delete this round? This cannot be undone.')) { cloudApi.markDeleted(r.id); store.update(st => { st.rounds = st.rounds.filter(x => x.id !== r.id); if (st.active === r.id) st.active = null; }); location.hash = 'rounds'; }
    if (b.dataset.act === 'resume') { store.update(st => { st.active = r.id; r.done = false; }); resetShotUi(r); location.hash = 'play'; }
  };
}

// ================= ACCOUNT / FRIENDS =================
function syncLine() {
  if (!cloud.user) return '';
  const t = cloud.lastSync ? cloud.lastSync.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : null;
  const msg = { syncing: 'Syncing…', offline: 'Offline — will sync when back online', error: 'Sync failed — will retry' }[cloud.status] || (t ? `Synced ${t}` : 'Not synced yet');
  return `<div class="syncline muted sm"><span class="dot ${cloud.status}"></span>${msg}</div>`;
}

const authUi = { mode: 'signin', busy: false, msg: '' };
function renderAccount() {
  if (!cloud.enabled) { view.innerHTML = `<section class="page"><h2 class="pagetitle">Account</h2><div class="card"><p class="muted">Accounts aren't configured on this server yet.</p></div></section>`; view.onclick = view.onsubmit = null; return; }
  if (cloud.recovery) {
    view.innerHTML = `<section class="page"><h2 class="pagetitle">New password</h2>
      <form class="card form" data-form="newpw"><label>New password<input name="pw" type="password" minlength="8" autocomplete="new-password" required></label>
      <button class="btn primary">Save password</button>${authUi.msg ? `<p class="formmsg">${esc(authUi.msg)}</p>` : ''}</form></section>`;
  } else if (cloud.user) {
    const p = cloud.profile || {};
    view.innerHTML = `<section class="page"><a href="#friends" class="back">‹ Friends</a><h2 class="pagetitle">Account</h2>
      <form class="card form" data-form="profile"><div class="eyebrow">Profile</div>
        <label>Display name<input name="display_name" value="${esc(p.display_name)}" maxlength="40"></label>
        <div class="muted sm">Username @${esc(p.username)} · ${esc(cloud.user.email)}</div>
        <button class="btn outline">Save</button>${authUi.msg ? `<p class="formmsg">${esc(authUi.msg)}</p>` : ''}</form>
      <div class="card">${syncLine()}<button class="btn ghost" data-act="signout">Sign out</button>
        <p class="muted sm">Signing out removes your synced rounds from this device. They stay in your account.</p></div></section>`;
  } else {
    const m = authUi.mode;
    view.innerHTML = `<section class="page">
      <div class="hero grid-bg"><div class="eyebrow">Carry account</div><h1>${m === 'signup' ? 'Create account' : m === 'reset' ? 'Reset password' : 'Sign in'}</h1>
        <p class="muted">Back up your rounds, use them on any device, and compare with friends.</p></div>
      <form class="card form" data-form="${m}">
        ${m === 'signup' ? `<label>Username<input name="username" autocomplete="username" autocapitalize="none" pattern="[a-zA-Z0-9_]{3,20}" title="3–20 letters, numbers or _" required></label>
          <label>Display name<input name="display_name" maxlength="40" placeholder="Optional"></label>` : ''}
        <label>Email<input name="email" type="email" autocomplete="email" autocapitalize="none" required></label>
        ${m !== 'reset' ? `<label>Password<input name="pw" type="password" minlength="8" autocomplete="${m === 'signup' ? 'new-password' : 'current-password'}" required></label>` : ''}
        <button class="btn primary" ${authUi.busy ? 'disabled' : ''}>${authUi.busy ? 'Please wait…' : m === 'signup' ? 'Create account' : m === 'reset' ? 'Send reset link' : 'Sign in'}</button>
        ${authUi.msg ? `<p class="formmsg">${esc(authUi.msg)}</p>` : ''}
      </form>
      <div class="row center">${m !== 'signin' ? '<button class="linkbtn" data-mode="signin">I have an account</button>' : '<button class="linkbtn" data-mode="signup">Create an account</button><button class="linkbtn" data-mode="reset">Forgot password?</button>'}</div>
    </section>`;
  }
  view.onclick = async e => {
    const m = e.target.closest('[data-mode]'); if (m) { authUi.mode = m.dataset.mode; authUi.msg = ''; return renderAccount(); }
    if (e.target.closest('[data-act="signout"]')) { await cloudApi.signOut(); social.fs = null; social.rows = null; toast('Signed out'); location.hash = 'friends'; }
  };
  view.onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target)); const kind = e.target.dataset.form;
    authUi.busy = true; authUi.msg = ''; renderAccount();
    try {
      if (kind === 'signin') { await cloudApi.signIn({ email: f.email, password: f.pw }); toast('Signed in'); location.hash = 'friends'; }
      else if (kind === 'signup') {
        if (!(await cloudApi.usernameAvailable(f.username))) throw new Error('That username is taken.');
        const { needsConfirm } = await cloudApi.signUp({ email: f.email, password: f.pw, username: f.username, displayName: f.display_name });
        authUi.mode = 'signin';
        authUi.msg = needsConfirm ? 'Check your email to confirm your account, then sign in.' : '';
        if (!needsConfirm) location.hash = 'friends';
      } else if (kind === 'reset') { await cloudApi.resetPassword(f.email); authUi.msg = 'If that email has an account, a reset link is on its way.'; }
      else if (kind === 'newpw') { await cloudApi.setNewPassword(f.pw); toast('Password updated'); location.hash = 'friends'; }
      else if (kind === 'profile') { await cloudApi.updateProfile({ display_name: f.display_name.trim() }); toast('Saved'); }
    } catch (err) { authUi.msg = err.message || 'Something went wrong.'; }
    authUi.busy = false;
    if (route() === 'account') renderAccount();
  };
}

const social = { fs: null, rows: null, loading: false, period: String(new Date().getFullYear()), metric: 'low', search: [], err: '' };
const METRICS = [['low', 'Low round', 1], ['avg', 'Scoring avg', 1], ['sg', 'SG / round', -1], ['ott', 'Off the tee', -1], ['app', 'Approach', -1], ['arg', 'Around green', -1], ['putt', 'Putting', -1]];

async function loadSocial(force) {
  if (!cloud.user || social.loading || (social.fs && !force)) return;
  social.loading = true;
  try {
    social.fs = await cloudApi.friendships();
    social.rows = await cloudApi.roundSummaries([cloud.user.id, ...social.fs.friends.map(p => p.id)], null);
    social.err = '';
  } catch (e) { social.err = e.message; social.fs ||= { friends: [], incoming: [], outgoing: [] }; }
  social.loading = false;
  if (['friends', 'friend'].includes(route())) render();
}

function perPlayer(rows, period) {
  const by = {};
  for (const r of rows) {
    if (period !== 'all' && !r.date.startsWith(period)) continue;
    if (r.summary?.holes !== 18) continue;
    (by[r.user_id] ||= []).push(r);
  }
  const out = {};
  for (const [id, rs] of Object.entries(by)) {
    const n = rs.length, avg = f => rs.reduce((a, r) => a + f(r.summary), 0) / n;
    out[id] = { n, low: Math.min(...rs.map(r => r.summary.score)), avg: avg(s => s.score), sg: avg(s => s.sgTotal), ott: avg(s => s.sg.ott), app: avg(s => s.sg.app), arg: avg(s => s.sg.arg), putt: avg(s => s.sg.putt) };
  }
  return out;
}
const fmtMetric = (k, v) => v == null ? '—' : k === 'low' ? v : k === 'avg' ? v.toFixed(1) : sgFmt(v);

function renderFriends() {
  if (!cloud.enabled || !cloud.user) {
    view.innerHTML = `<section class="page"><h2 class="pagetitle">Friends</h2>
      <div class="hero grid-bg"><div class="eyebrow">Play together</div><h1>Compete with friends</h1>
      <p class="muted">Follow friends, see their rounds and strokes gained, and climb the leaderboards. Your rounds also back up to your account and show up on every device you sign in on.</p></div>
      ${cloud.enabled ? '<a class="btn primary full" href="#account">Sign in or create account</a>' : '<div class="card"><p class="muted sm">Accounts aren\'t configured on this server yet (see README → Accounts).</p></div>'}</section>`;
    view.onclick = view.onsubmit = null; return;
  }
  loadSocial();
  const fs = social.fs, me = cloud.user.id;
  const people = fs ? [{ id: me, username: cloud.profile?.username, display_name: 'You' }, ...fs.friends] : [];
  const stats = social.rows ? perPlayer(social.rows, social.period) : {};
  const [mk, , dir] = METRICS.find(m => m[0] === social.metric);
  const board = people.filter(p => stats[p.id]).sort((a, b) => (stats[a.id][mk] - stats[b.id][mk]) * dir);
  const years = [...new Set((social.rows || []).map(r => r.date.slice(0, 4)))].sort().reverse();
  if (!years.includes(social.period) && social.period !== 'all') years.unshift(social.period);
  view.innerHTML = `
    <section class="page">
      <div class="titlerow"><h2 class="pagetitle">Friends</h2><a class="btn ghost sm" href="#account">@${esc(cloud.profile?.username || '')}</a></div>
      ${social.err ? `<div class="banner">${esc(social.err)}</div>` : ''}
      ${fs?.incoming.length ? `<div class="card"><div class="eyebrow">Friend requests</div><ul class="list">${fs.incoming.map(p => `<li class="personrow"><span><b>${esc(p.display_name)}</b> <span class="muted">@${esc(p.username)}</span></span><span class="row"><button class="btn primary sm" data-accept="${p.id}">Accept</button><button class="btn ghost sm" data-remove="${p.id}">Decline</button></span></li>`).join('')}</ul></div>` : ''}
      <div class="card">
        <div class="eyebrow">Leaderboard <span class="muted">· 18-hole rounds</span></div>
        <div class="chips">${[...years, 'all'].map(y => `<button class="chip sm ${social.period === y ? 'on' : ''}" data-period="${y}">${y === 'all' ? 'All time' : y}</button>`).join('')}</div>
        <div class="chips">${METRICS.map(([k, l]) => `<button class="chip ${social.metric === k ? 'on' : ''}" data-metric="${k}">${l}</button>`).join('')}</div>
        ${!fs ? '<p class="muted">Loading…</p>' : board.length ? `<ol class="board">${board.map((p, i) => `<li class="${p.id === me ? 'me' : ''}"><span class="mono rank">${i + 1}</span><a href="${p.id === me ? '#stats' : '#friend/' + p.id}" class="who">${esc(p.display_name)} <span class="muted sm">${stats[p.id].n} rd${stats[p.id].n === 1 ? '' : 's'}</span></a><span class="mono val ${mk === 'low' || mk === 'avg' ? '' : sgClass(stats[p.id][mk])}">${fmtMetric(mk, stats[p.id][mk])}</span></li>`).join('')}</ol>` : `<p class="muted sm">No completed 18-hole rounds ${social.period === 'all' ? 'yet' : 'in ' + social.period}. Finished rounds appear here once synced.</p>`}
      </div>
      <div class="card"><div class="eyebrow">Your friends</div>
        ${fs ? (fs.friends.length ? `<ul class="list">${fs.friends.map(p => `<li><a class="listbtn" href="#friend/${p.id}"><span>${esc(p.display_name)} <span class="muted">@${esc(p.username)}</span></span><span class="muted">›</span></a></li>`).join('')}</ul>` : '<p class="muted sm">No friends yet — find them by username below.</p>') : ''}
        ${fs?.outgoing.length ? `<div class="muted sm">Waiting for: ${fs.outgoing.map(p => '@' + esc(p.username)).join(', ')}</div>` : ''}
      </div>
      <div class="card"><div class="eyebrow">Add a friend</div>
        <form class="searchrow" data-form="usersearch"><input name="q" placeholder="Username" autocomplete="off" autocapitalize="none"><button class="btn outline">Search</button></form>
        ${social.search.length ? `<ul class="list">${social.search.map(p => { const st = fs?.friends.some(x => x.id === p.id) ? 'Friends' : fs?.outgoing.some(x => x.id === p.id) ? 'Requested' : fs?.incoming.some(x => x.id === p.id) ? 'Wants to add you' : null;
          return `<li class="personrow"><span><b>${esc(p.display_name)}</b> <span class="muted">@${esc(p.username)}</span></span>${st ? `<span class="muted sm">${st}</span>` : `<button class="btn outline sm" data-add="${p.id}">Add</button>`}</li>`; }).join('')}</ul>` : ''}
      </div>
    </section>`;
  view.onclick = async e => {
    const t = e.target.closest('[data-period],[data-metric],[data-accept],[data-remove],[data-add]'); if (!t) return;
    try {
      if (t.dataset.period) social.period = t.dataset.period;
      else if (t.dataset.metric) social.metric = t.dataset.metric;
      else if (t.dataset.accept) { await cloudApi.acceptRequest(t.dataset.accept); toast('Friend added'); return loadSocial(true); }
      else if (t.dataset.remove) { await cloudApi.removeFriend(t.dataset.remove); return loadSocial(true); }
      else if (t.dataset.add) { await cloudApi.sendRequest(t.dataset.add); toast('Request sent'); return loadSocial(true); }
    } catch (err) { toast(err.message); }
    renderFriends();
  };
  view.onsubmit = async e => {
    e.preventDefault();
    try { social.search = await cloudApi.searchUsers(e.target.q.value); if (!social.search.length) toast('No players found'); } catch (err) { toast(err.message); }
    renderFriends();
  };
}

function renderFriend() {
  const id = location.hash.split('/')[1];
  if (!cloud.user) { location.hash = 'friends'; return; }
  loadSocial();
  const p = social.fs?.friends.find(x => x.id === id);
  if (social.fs && !p) { location.hash = 'friends'; return; }
  const yr = String(new Date().getFullYear());
  const statsY = social.rows ? perPlayer(social.rows, yr) : {};
  const them = statsY[id], mine = statsY[cloud.user.id];
  const rounds = (social.rows || []).filter(r => r.user_id === id);
  view.innerHTML = `
    <section class="page">
      <a href="#friends" class="back">‹ Friends</a>
      <h2 class="pagetitle">${esc(p?.display_name || '…')}</h2><div class="muted">@${esc(p?.username || '')}</div>
      <div class="card"><div class="eyebrow">${yr} head to head <span class="muted">· per 18-hole round</span></div>
        ${them || mine ? `<table class="tbl"><thead><tr><th></th><th>${esc(p?.display_name || '')}</th><th>You</th></tr></thead><tbody>
          ${METRICS.map(([k, l, dir]) => { const a = them?.[k], b = mine?.[k]; const win = a != null && b != null && a !== b ? ((a - b) * dir < 0 ? 'a' : 'b') : '';
            return `<tr><td>${l}</td><td class="mono ${win === 'a' ? 'accent' : ''}">${fmtMetric(k, a)}</td><td class="mono ${win === 'b' ? 'accent' : ''}">${fmtMetric(k, b)}</td></tr>`; }).join('')}
          <tr><td>Rounds</td><td class="mono">${them?.n || 0}</td><td class="mono">${mine?.n || 0}</td></tr></tbody></table>` : '<p class="muted sm">No 18-hole rounds this year yet.</p>'}
      </div>
      <div class="card"><div class="eyebrow">Shared rounds</div>
        ${rounds.length ? `<ul class="list">${rounds.map(r => `<li><a class="listbtn" href="#fround/${encodeURIComponent(r.id)}"><span>${esc(r.course)} <span class="muted sm">${fmtDate(r.date)} ${r.date.slice(0, 4)}</span></span><span class="mono">${r.summary.score} <span class="muted">${toParStr(r.summary.toPar)}</span></span></a></li>`).join('')}</ul>` : '<p class="muted sm">No shared rounds yet.</p>'}
      </div>
      <button class="btn ghost" data-act="unfriend">Remove friend</button>
    </section>`;
  view.onsubmit = null;
  view.onclick = async e => {
    if (e.target.closest('[data-act="unfriend"]') && confirm('Remove this friend? You will stop seeing each other\'s rounds.')) {
      await cloudApi.removeFriend(id).catch(err => toast(err.message)); await loadSocial(true); location.hash = 'friends';
    }
  };
}

async function renderFriendRound() {
  const id = decodeURIComponent(location.hash.split('/')[1] || '');
  if (!cloud.user) { location.hash = 'friends'; return; }
  view.innerHTML = '<section class="page"><p class="muted">Loading round…</p></section>';
  try {
    const row = await cloudApi.fetchRound(id);
    if (!row) throw new Error('Round not found or not shared with you.');
    if (route() !== 'fround') return;
    const owner = social.fs?.friends.find(p => p.id === row.user_id) || { username: '', display_name: 'Friend' };
    renderRoundView(row.data, { back: '#friend/' + row.user_id, backLabel: owner.display_name, owner });
  } catch (e) { view.innerHTML = `<section class="page"><a href="#friends" class="back">‹ Friends</a><div class="card"><p class="muted">${esc(e.message)}</p></div></section>`; }
}

// ================= SETTINGS =================
function renderSettings() {
  const p = store.get().profile;
  view.innerHTML = `
    <section class="page">
      <a href="#rounds" class="back">‹ Rounds</a>
      <h2 class="pagetitle">Settings</h2>
      ${cloud.enabled ? `<div class="card"><div class="eyebrow">Account</div>${cloud.user ? `<div><b>${esc(cloud.profile?.display_name || '')}</b> <span class="muted">@${esc(cloud.profile?.username || '')}</span><div class="muted sm">${esc(cloud.user.email)}</div></div>${syncLine()}<div class="row"><button class="btn outline sm" data-act="syncnow">Sync now</button><a class="btn ghost sm" href="#account">Account</a></div>` : `<p class="muted sm">Sign in to back up your rounds, use them on any device and compete with friends.</p><a class="btn primary" href="#account">Sign in or create account</a>`}</div>` : ''}
      <div class="card"><div class="eyebrow">Distance units</div><div class="chips">${[['yd', 'Yards'], ['m', 'Meters']].map(([v, l]) => `<button class="chip ${p.units === v ? 'on' : ''}" data-u="${v}">${l}</button>`).join('')}</div></div>
      <div class="card"><div class="eyebrow">Your bag</div><div class="chips">${CLUBS.map(c => `<button class="chip ${p.bag.includes(c) ? 'on' : ''}" data-c="${c}">${c}</button>`).join('')}</div></div>
      <div class="card"><div class="eyebrow">AI caddie</div><p class="muted sm">${aiOn ? 'Connected. Free-form questions are answered by Claude using a summary of your stats; club lookups and records are answered on-device.' : 'Off. Run the server with ANTHROPIC_API_KEY set to enable free-form questions. Club picks, distances and records work without it.'}</p></div>
      <div class="card"><div class="eyebrow">Data</div><p class="muted sm">${cloud.user ? 'Stored on this device and synced to your account.' : 'Everything is stored on this device.'}</p>
        <div class="row"><button class="btn outline" data-act="export">Export JSON</button><button class="btn ghost" data-act="cleardemo">Remove demo rounds</button><button class="btn ghost" data-act="reset">Erase all</button></div></div>
    </section>`;
  view.onclick = e => {
    const u = e.target.closest('[data-u]'), c = e.target.closest('[data-c]'), a = e.target.closest('[data-act]');
    if (u) store.update(s => { s.profile.units = u.dataset.u; });
    if (c) store.update(s => { const b = s.profile.bag; s.profile.bag = b.includes(c.dataset.c) ? b.filter(x => x !== c.dataset.c) : CLUBS.filter(x => b.includes(x) || x === c.dataset.c); });
    if (a?.dataset.act === 'cleardemo') { store.clearDemo(); toast('Demo rounds removed'); }
    if (a?.dataset.act === 'syncnow') { cloudApi.syncNow(); }
    if (a?.dataset.act === 'reset' && confirm('Erase all rounds, courses and settings on this device?')) { store.reset(false); toast('All data erased'); }
    if (a?.dataset.act === 'export') {
      const blob = new Blob([JSON.stringify(store.get(), null, 2)], { type: 'application/json' });
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'carry-export.json'; link.click();
    }
    if (u || c || a) renderSettings();
  };
}

if ('serviceWorker' in navigator && location.hostname !== '') navigator.serviceWorker.register('sw.js').catch(() => {});
const r0 = store.activeRound(); if (r0) resetShotUi(r0);
render();
cloud.onChange(kind => {
  if (cloud.notice) { toast(cloud.notice); cloud.notice = null; }
  if (kind === 'status') { document.querySelectorAll('.syncline').forEach(el => { el.outerHTML = syncLine(); }); return; }
  if (['friends', 'account', 'settings', 'rounds', 'stats'].includes(route()) && !view.contains(document.activeElement?.closest('input'))) {
    const y = view.scrollTop; render(); view.scrollTop = y;
  }
});
cloudApi.initCloud();
