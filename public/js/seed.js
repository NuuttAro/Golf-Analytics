// Demo data: simulated rounds for a ~12 handicap so stats and the caddie
// have something to learn from. Marked `demo: true` so they can be cleared.
import { makeProb } from './sg.js';

const COURSES = [
  { name: 'Pine Ridge GC', holes: [[4,385],[3,168],[5,512],[4,402],[4,356],[3,191],[4,428],[5,498],[4,371],[4,394],[3,152],[5,535],[4,410],[4,338],[3,204],[4,419],[5,488],[4,441]] },
  { name: 'Lakeside Links', holes: [[4,362],[4,398],[3,145],[5,520],[4,415],[4,340],[3,178],[5,505],[4,433],[4,376],[5,492],[3,163],[4,404],[4,388],[3,186],[4,352],[5,540],[4,420]] },
];

const MED = { Dr: 242, '3W': 222, '5W': 208, '4H': 194, '5i': 181, '6i': 170, '7i': 158, '8i': 147, '9i': 135, PW: 122, GW: 108, SW: 92, LW: 74 };
const LIEF = { tee: 1, fairway: 1, rough: 0.92, sand: 0.86, recovery: 0.75 };

function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export function seedRounds() {
  const r = rng(42);
  const gauss = () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const pickClub = (d, lie) => {
    let best = 'LW', bd = 1e9;
    for (const [c, m] of Object.entries(MED)) { if (c === 'Dr' && lie !== 'tee') continue; const e = Math.abs(m * LIEF[lie] - d); if (e < bd) { bd = e; best = c; } }
    return best;
  };

  // Shots are simulated along the hole's centre line (x = yards from tee,
  // y = lateral yards) and saved with lat/lng, the same way GPS-logged shots are.
  const YD_LAT = 1 / 121740, YD_LNG = 1 / 60580; // ≈ yards per degree at 60°N
  function playHole(par, len, origin) {
    const shots = [];
    let lie = 'tee', x = 0, y = 0, guard = 0;
    const at = () => ({ lat: +(origin.lat + x * YD_LAT).toFixed(6), lng: +(origin.lng + y * YD_LNG).toFixed(6) });
    const left = () => Math.hypot(len - x, y);
    while (guard++ < 15) {
      if (lie === 'green') {
        const ft = Math.max(1, left() * 3);
        shots.push({ lie, dist: Math.round(ft), club: 'Putter', ...at() });
        const p = Math.min(0.97, makeProb(ft) * 0.97 + (ft < 3 ? 0.05 : 0));
        if (r() < p) return shots;
        const nextFt = Math.max(1, Math.abs(ft * 0.08 + gauss() * 1.4) + 0.6);
        x = len - nextFt / 3; y = 0; continue;
      }
      const dist = left();
      const club = lie === 'tee' && par >= 4 ? 'Dr' : (dist <= 60 ? (dist < 25 ? 'LW' : 'SW') : pickClub(dist, lie));
      shots.push({ lie, dist: Math.round(dist), club, ...at() });
      const shot = shots[shots.length - 1];
      if (dist <= 45) { // short game: finish 15-25% of the distance away
        if (r() < 0.03) return shots; // chip-in
        if (r() < (lie === 'sand' ? 0.18 : 0.1)) { x = len - dist * 0.4; y = 0; lie = 'rough'; continue; }
        const ft = Math.abs(dist * 3 * (lie === 'sand' ? 0.28 : 0.2) + gauss() * dist * 0.3 + 3);
        x = len - ft / 3; y = 0; lie = 'green'; continue;
      }
      const full = MED[club] * LIEF[lie];
      const carry = full * (1 + gauss() * (club === 'Dr' ? 0.07 : 0.06));
      const travel = Math.min(carry, dist + 30);
      const side = gauss() * travel * (club === 'Dr' ? 0.09 : 0.07);
      const ux = (len - x) / dist, uy = -y / dist; // unit vector towards the pin
      x += ux * travel - uy * side; y += uy * travel + ux * side;
      const roll = r();
      if (lie === 'tee' && par >= 4) {
        if (Math.abs(y) > 38 || roll < 0.03) { shot.penalty = true; y = Math.sign(y || 1) * 30; lie = 'rough'; continue; }
        lie = Math.abs(y) < 16 ? (roll < 0.1 ? 'sand' : 'fairway') : (roll < 0.15 ? 'recovery' : 'rough');
        continue;
      }
      if (left() < 11 && roll < 0.85) { lie = 'green'; continue; }
      lie = roll < 0.78 ? 'rough' : 'sand';
      if (roll > 0.97) { shot.penalty = true; }
    }
    return shots;
  }

  const rounds = [];
  const dates = [
    '2025-08-14', '2025-09-02', '2025-09-21', '2025-10-05',
    '2026-04-26', '2026-05-09', '2026-05-23', '2026-06-06', '2026-06-14', '2026-06-27',
    '2026-07-08', '2026-07-19', '2026-08-01', '2026-08-15', '2026-08-29', '2026-09-12', '2026-09-26', '2026-10-10',
  ];
  dates.forEach((date, i) => {
    const c = COURSES[i % 2];
    rounds.push({
      id: 'demo' + i, demo: true, date, course: c.name, done: true, current: 18,
      holes: c.holes.map(([par, len], n) => ({ n: n + 1, par, len, shots: playHole(par, len, { lat: 60.2 + n * 0.01, lng: 24.9 + (i % 2) * 0.05 }), holed: true })),
    });
  });
  return rounds.reverse();
}
