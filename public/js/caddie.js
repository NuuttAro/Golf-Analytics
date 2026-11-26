// AI caddie: learns club distances and club outcomes from logged shots,
// recommends clubs, and answers questions about the player's game.
import { analyzeHole, roundSummary, CATS } from './sg.js';
import { store, fmtD, unit, fromUnit, CLUBS } from './store.js';

const LIE_FACTOR = { tee: 1, fairway: 1, rough: 0.92, sand: 0.86, recovery: 0.75 };
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]; };

/** Every analysed full shot (club, lie, start distance, travel, sg) across all rounds. */
export function shotLog() {
  const out = [];
  for (const r of store.get().rounds) for (const h of r.holes) for (const s of analyzeHole(h)) {
    if (s.lie === 'green' || s.club === 'Putter' || !s.club) continue;
    out.push({ ...s, date: r.date, round: r.id });
  }
  return out;
}

/** Learned distance profile per club. Partial shots (inside 55y) are ignored. */
export function clubStats() {
  const by = {};
  for (const s of shotLog()) {
    if (s.travel == null || s.penalty || s.dist < 55) continue;
    (by[s.club] ||= { all: [], lie: {} });
    by[s.club].all.push(s.travel);
    (by[s.club].lie[s.lie] ||= []).push(s.travel);
  }
  const stats = {};
  for (const c of CLUBS) {
    const d = by[c]; if (!d || d.all.length < 2) continue;
    const xs = d.all;
    stats[c] = {
      n: xs.length, median: median(xs), lo: pct(xs, 0.2), hi: pct(xs, 0.8), max: Math.max(...xs),
      lie: Object.fromEntries(Object.entries(d.lie).filter(([, v]) => v.length >= 3).map(([k, v]) => [k, median(v)])),
    };
  }
  return stats;
}

/**
 * Recommend a club for a situation.
 * target: yards to the target, lie, wind (mph, + = into), elev (yards, + = uphill)
 */
export function recommend({ target, lie = 'fairway', wind = 0, elev = 0 }) {
  const stats = clubStats();
  if (lie === 'green') return { playsLike: target, picks: [], note: 'You are on the green — putter.' };
  const windAdj = wind > 0 ? target * 0.01 * wind : target * 0.005 * wind;
  const playsLike = target + windAdj + elev;
  const log = shotLog();
  const picks = [];
  for (const [club, st] of Object.entries(stats)) {
    if (club === 'Dr' && lie !== 'tee') continue;
    // Prefer what this player actually hits from this lie; else scale.
    const learnedLie = st.lie[lie];
    const exp = learnedLie ?? st.median * (LIE_FACTOR[lie] ?? 1);
    const spread = Math.max(6, (st.hi - st.lo) / 2);
    const fit = Math.abs(exp - playsLike) / spread;
    // Outcome learning: how did this club score (SG) from similar spots?
    const similar = log.filter(s => s.club === club && Math.abs(s.dist - target) <= 15 && (s.lie === lie || (lie !== 'tee' && s.lie !== 'tee')));
    const sgAvg = similar.length ? similar.reduce((a, s) => a + s.sg, 0) / similar.length : null;
    const conf = similar.length >= 5 ? Math.min(1, similar.length / 15) : 0;
    const score = fit - (sgAvg != null ? sgAvg * 1.2 * conf : 0);
    picks.push({ club, exp, spread, fit, sgAvg, similarN: similar.length, n: st.n, learnedLie: learnedLie != null, score });
  }
  picks.sort((a, b) => a.score - b.score);
  return { playsLike, windAdj, elev, picks: picks.slice(0, 3) };
}

export function explain(rec, lie) {
  const [p, alt] = rec.picks;
  if (!p) return rec.note || 'Log a few rounds so I can learn your distances.';
  let t = `**${p.club}** — your ${p.club} goes ${fmtD(p.exp)}${unit()}${p.learnedLie ? ` from the ${lie}` : ''} (median of ${p.n} shots).`;
  if (Math.abs(rec.playsLike - (rec.target ?? rec.playsLike)) >= 2) t += ` Plays like ${fmtD(rec.playsLike)}${unit()}.`;
  if (p.sgAvg != null && p.similarN >= 3) t += ` From similar spots it's averaged ${sgFmt(p.sgAvg)} SG (${p.similarN} shots).`;
  if (alt) t += ` Backup: ${alt.club} (${fmtD(alt.exp)}${unit()}).`;
  return t;
}

export const sgFmt = v => v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);

// ---------- Season / history facts ----------
export function roundsWithSummary() {
  return store.get().rounds.filter(r => r.holes.every(h => h.holed) && r.holes.length >= 9)
    .map(r => ({ r, s: roundSummary(r) }));
}

function seasonAverages(list) {
  const n = list.length || 1;
  const avg = k => list.reduce((a, x) => a + x.s.sg[k], 0) / n;
  return {
    rounds: list.length,
    score: list.reduce((a, x) => a + x.s.score, 0) / n,
    putts: list.reduce((a, x) => a + x.s.putts, 0) / n,
    fir: list.reduce((a, x) => a + x.s.fir, 0) / Math.max(1, list.reduce((a, x) => a + x.s.firN, 0)),
    gir: list.reduce((a, x) => a + x.s.gir, 0) / Math.max(1, list.reduce((a, x) => a + x.s.girN, 0)),
    sg: { ott: avg('ott'), app: avg('app'), arg: avg('arg'), putt: avg('putt') },
  };
}
export { seasonAverages };

const CLUB_ALIASES = [
  [/\b(driver|dr)\b/, 'Dr'], [/\b(3|three)[ -]?(w|wood)\b/, '3W'], [/\b(5|five)[ -]?(w|wood)\b/, '5W'],
  [/\b(4|four)[ -]?(h|hybrid)\b|\bhybrid\b/, '4H'], [/\b(pw|pitching wedge)\b/, 'PW'], [/\b(gw|gap wedge|aw|approach wedge)\b/, 'GW'],
  [/\b(sw|sand wedge)\b/, 'SW'], [/\b(lw|lob wedge)\b/, 'LW'], [/\bputter\b/, 'Putter'],
  [/\b([4-9])[ -]?(i|iron)\b/, m => m[1] + 'i'],
];
function findClub(q) {
  for (const [re, c] of CLUB_ALIASES) { const m = q.match(re); if (m) return typeof c === 'function' ? c(m) : c; }
  return null;
}
function findYear(q) {
  const m = q.match(/\b(20\d\d)\b/); if (m) return +m[1];
  if (/last (year|season)/.test(q)) return new Date().getFullYear() - 1;
  if (/(all[- ]time|ever|career)/.test(q)) return null;
  return new Date().getFullYear();
}
const fmtDate = d => new Date(d + 'T12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const toParStr = n => n === 0 ? 'E' : (n > 0 ? '+' + n : '−' + Math.abs(n));

/** Answers questions locally from data. Returns null when it can't. */
export function answerLocally(raw) {
  const q = raw.toLowerCase();
  const u = unit();
  const lie = /bunker|sand|trap/.test(q) ? 'sand' : /rough/.test(q) ? 'rough' : /tee\b|off the tee/.test(q) ? 'tee' : /trees|recovery|punch/.test(q) ? 'recovery' : 'fairway';
  const distM = q.match(/(\d{2,3})\s*(yards|yds|yd|y|meters|metres|m)?\b/);
  const club = findClub(q);
  const stats = clubStats();

  // "how far does my 7 iron go" / "7 iron distance"
  if (club && /(how far|distance|carry|average|go|hit my)/.test(q) && !/(what|which) club/.test(q)) {
    const st = stats[club];
    if (!st) return `I don't have enough ${club} shots yet — log a few and I'll learn it.`;
    const lies = Object.entries(st.lie).filter(([l]) => l !== 'tee' && l !== 'fairway').map(([l, v]) => `${fmtD(v)}${u} from the ${l}`);
    return `Your **${club}** goes **${fmtD(st.median)}${u}** (typical ${fmtD(st.lo)}–${fmtD(st.hi)}${u}, longest ${fmtD(st.max)}${u}, ${st.n} shots).${lies.length ? ' ' + lies.join(', ') + '.' : ''}`;
  }

  // "what club for 150" / "what club goes 150 m"
  if (distM && /(club|hit|what|which|should)/.test(q) && !/round|score/.test(q)) {
    let d = +distM[1];
    const isM = distM[2] ? /^m/.test(distM[2]) : u === 'm';
    d = isM ? d / 0.9144 : (distM[2] ? d : fromUnit(d));
    const wind = (q.match(/(\d+)\s*mph\s*(into|head)/) || [])[1] * 1 || -((q.match(/(\d+)\s*mph\s*(down|tail|help)/) || [])[1] * 1) || 0;
    const rec = recommend({ target: d, lie, wind });
    rec.target = d;
    return explain(rec, lie);
  }

  if (/(lowest|best).*(round|score)|(round|score).*(lowest|best)/.test(q)) {
    const yr = findYear(q);
    const list = roundsWithSummary().filter(x => x.r.holes.length === 18 && (yr == null || x.r.date.startsWith(yr)));
    if (!list.length) return `No complete 18-hole rounds${yr ? ' in ' + yr : ''} yet.`;
    const b = list.reduce((a, x) => x.s.score < a.s.score ? x : a);
    return `Your lowest round${yr ? ' of ' + yr : ' ever'} is **${b.s.score}** (${toParStr(b.s.toPar)}) at ${b.r.course} on ${fmtDate(b.r.date)} — SG total ${sgFmt(b.s.sgTotal)}, ${b.s.putts} putts.`;
  }
  if (/(highest|worst).*(round|score)/.test(q)) {
    const yr = findYear(q);
    const list = roundsWithSummary().filter(x => x.r.holes.length === 18 && (yr == null || x.r.date.startsWith(yr)));
    if (!list.length) return 'No complete rounds for that period.';
    const b = list.reduce((a, x) => x.s.score > a.s.score ? x : a);
    return `Your highest round${yr ? ' of ' + yr : ''} is **${b.s.score}** at ${b.r.course} on ${fmtDate(b.r.date)}.`;
  }
  if (/how many rounds/.test(q)) {
    const yr = findYear(q);
    const n = roundsWithSummary().filter(x => yr == null || x.r.date.startsWith(yr)).length;
    return `You've logged **${n}** complete rounds${yr ? ' in ' + yr : ''}.`;
  }

  const yr = findYear(q);
  const season = seasonAverages(roundsWithSummary().filter(x => yr == null || x.r.date.startsWith(yr)));
  if (/(average|avg|mean).*(score)|scoring average/.test(q)) return `Scoring average${yr ? ' in ' + yr : ''}: **${season.score.toFixed(1)}** over ${season.rounds} rounds.`;
  if (/putt/.test(q)) return `You average **${season.putts.toFixed(1)} putts** per round; putting SG is ${sgFmt(season.sg.putt)} per round.`;
  if (/fairway/.test(q)) return `You hit **${Math.round(season.fir * 100)}%** of fairways${yr ? ' in ' + yr : ''}.`;
  if (/\bgir\b|greens in reg|greens hit/.test(q)) return `Greens in regulation: **${Math.round(season.gir * 100)}%**.`;
  if (/strokes gained|\bsg\b|weak|strong|losing|lose|improve|practice|work on/.test(q)) {
    const rows = Object.entries(season.sg).sort((a, b) => a[1] - b[1]);
    const [worst] = rows, best = rows[rows.length - 1];
    return `Per round vs tour baseline: ${rows.map(([k, v]) => `${CATS[k]} ${sgFmt(v)}`).join(', ')}. Biggest leak: **${CATS[worst[0]]}**; strongest: ${CATS[best[0]]}.`;
  }
  if (/(my bag|all clubs|distances|yardages|gapping)/.test(q)) {
    const rows = Object.entries(stats).map(([c, s]) => `${c} ${fmtD(s.median)}`);
    return rows.length ? `Your distances (${u}): ${rows.join(' · ')}` : 'No club data yet.';
  }
  return null;
}

/** Compact data bundle for the Claude-powered answers. */
export function aiContext() {
  const st = store.get();
  const list = roundsWithSummary();
  const stats = clubStats();
  const conv = v => Math.round(st.profile.units === 'm' ? v * 0.9144 : v);
  const active = store.activeRound();
  return {
    units: st.profile.units === 'm' ? 'meters' : 'yards',
    today: new Date().toISOString().slice(0, 10),
    clubs: Object.fromEntries(Object.entries(stats).map(([c, s]) => [c, { median: conv(s.median), p20: conv(s.lo), p80: conv(s.hi), shots: s.n, byLie: Object.fromEntries(Object.entries(s.lie).map(([l, v]) => [l, conv(v)])) }])),
    sgBaseline: 'PGA Tour; negative = strokes lost per round',
    seasonThisYear: seasonAverages(list.filter(x => x.r.date.startsWith(String(new Date().getFullYear())))),
    allTime: seasonAverages(list),
    rounds: list.map(x => ({ date: x.r.date, course: x.r.course, holes: x.s.holes, score: x.s.score, toPar: x.s.toPar, putts: x.s.putts, sg: Object.fromEntries(Object.entries(x.s.sg).map(([k, v]) => [k, +v.toFixed(2)])) })),
    currentRound: active ? { course: active.course, hole: active.current, holes: active.holes.map(h => ({ n: h.n, par: h.par, strokes: h.shots.length })) } : null,
  };
}
