// Strokes gained engine.
// Baseline = expected strokes to hole out for a PGA Tour player (after Broadie,
// "Every Shot Counts"). Off-green distances in yards, green distances in feet.

const BASE = {
  tee: [[100,2.92],[120,2.99],[140,2.97],[160,2.99],[180,3.05],[200,3.12],[220,3.17],[240,3.25],[260,3.45],[280,3.65],[300,3.71],[320,3.79],[340,3.86],[360,3.92],[380,3.96],[400,3.99],[420,4.02],[440,4.08],[460,4.17],[480,4.28],[500,4.41],[520,4.54],[540,4.65],[560,4.74],[580,4.79],[600,4.82],[650,4.95]],
  fairway: [[5,2.10],[10,2.18],[20,2.40],[30,2.52],[40,2.60],[50,2.66],[60,2.70],[80,2.75],[100,2.80],[120,2.85],[140,2.91],[160,2.98],[180,3.08],[200,3.19],[220,3.32],[240,3.45],[260,3.58],[280,3.69],[300,3.78],[350,3.95],[400,4.05],[500,4.40],[600,4.80]],
  rough: [[5,2.25],[10,2.35],[20,2.59],[30,2.70],[40,2.78],[60,2.91],[80,2.96],[100,3.02],[120,3.08],[140,3.15],[160,3.23],[180,3.31],[200,3.42],[220,3.53],[240,3.64],[260,3.74],[280,3.83],[300,3.90],[400,4.15],[600,4.90]],
  sand: [[5,2.30],[10,2.40],[20,2.53],[30,2.66],[40,2.82],[60,3.15],[80,3.24],[100,3.23],[120,3.21],[140,3.22],[160,3.28],[180,3.40],[200,3.55],[220,3.70],[240,3.84],[260,3.93],[280,4.00],[300,4.04],[400,4.30]],
  recovery: [[20,3.10],[50,3.30],[100,3.80],[120,3.78],[140,3.80],[160,3.81],[180,3.82],[200,3.87],[220,3.92],[240,3.97],[260,4.03],[280,4.10],[300,4.20],[400,4.50]],
  green: [[1,1.001],[2,1.01],[3,1.04],[4,1.13],[5,1.23],[6,1.34],[7,1.42],[8,1.50],[9,1.56],[10,1.61],[12,1.68],[15,1.78],[20,1.87],[25,1.93],[30,1.98],[40,2.06],[50,2.14],[60,2.21],[70,2.28],[80,2.34],[90,2.40],[120,2.55]],
};

export const LIES = ['tee', 'fairway', 'rough', 'sand', 'recovery', 'green'];
export const CATS = { ott: 'Off the tee', app: 'Approach', arg: 'Around green', putt: 'Putting' };

function interp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x <= x1) {
      const [x0, y0] = table[i - 1];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  const [xa, ya] = table[table.length - 2], [xb, yb] = table[table.length - 1];
  return yb + (yb - ya) * (x - xb) / (xb - xa);
}

/** Expected strokes to hole out. dist: yards (off green) or feet (green). */
export function expected(lie, dist) {
  if (dist <= 0) return 0;
  return interp(BASE[lie] || BASE.fairway, dist);
}

/** Probability a tour player holes a putt of `ft` feet (rough, from baseline). */
export function makeProb(ft) {
  const e = expected('green', ft);
  return Math.max(0.01, Math.min(0.99, 2 - e)); // E ≈ 1·p + 2·(1-p) for short putts
}

export function category(shot, par) {
  if (shot.lie === 'green') return 'putt';
  if (shot.lie === 'tee' && par >= 4) return 'ott';
  if (shot.dist <= 30 && shot.lie !== 'tee') return 'arg';
  return 'app';
}

/** Annotate every shot of a hole with sg, cat, end state and travel distance. */
export function analyzeHole(hole) {
  const out = [];
  const shots = hole.shots || [];
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    const next = shots[i + 1];
    const startE = expected(s.lie, s.dist);
    let endE, travel = null;
    if (next) {
      endE = expected(next.lie, next.dist);
      if (s.lie !== 'green' && s.club !== 'Putter') {
        if (s.lat != null && next.lat != null) travel = haversineYds(s, next);
        else {
          const endYds = next.lie === 'green' ? next.dist / 3 : next.dist;
          travel = Math.max(0, s.dist - endYds);
        }
      }
    } else if (hole.holed) {
      endE = 0;
      if (s.lie !== 'green' && s.club !== 'Putter') travel = s.dist;
    } else {
      out.push({ ...s, sg: null, cat: category(s, hole.par), travel: null, nextLie: null });
      continue;
    }
    const pen = s.penalty ? 1 : 0;
    out.push({ ...s, sg: startE - endE - 1 - pen, cat: category(s, hole.par), travel, nextLie: next ? next.lie : 'holed' });
  }
  return out;
}

export function holeScore(hole) {
  return (hole.shots || []).reduce((n, s) => n + 1 + (s.penalty ? 1 : 0), 0);
}

export function roundSummary(round) {
  const sg = { ott: 0, app: 0, arg: 0, putt: 0 };
  let score = 0, par = 0, putts = 0, fir = 0, firN = 0, gir = 0, girN = 0, holes = 0, penalties = 0;
  for (const h of round.holes) {
    if (!h.holed) continue;
    holes++;
    const shots = analyzeHole(h);
    const strokes = holeScore(h);
    score += strokes; par += h.par;
    shots.forEach(s => { if (s.sg != null) sg[s.cat] += s.sg; if (s.lie === 'green') putts++; if (s.penalty) penalties++; });
    if (h.par >= 4 && shots[0]) { firN++; if (shots[0].nextLie === 'fairway' || shots[0].nextLie === 'green' || shots[0].nextLie === 'holed') fir++; }
    girN++;
    let strokesToGreen = 0, reached = false;
    for (const s of h.shots) { if (s.lie === 'green') { reached = true; break; } strokesToGreen += 1 + (s.penalty ? 1 : 0); }
    if (!reached) reached = true; // holed from off the green counts once it's in
    if (reached && strokesToGreen <= h.par - 2) gir++;
  }
  const total = sg.ott + sg.app + sg.arg + sg.putt;
  return { score, par, toPar: score - par, putts, fir, firN, gir, girN, holes, penalties, sg, sgTotal: total };
}

export function haversineYds(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) * 1.09361;
}
