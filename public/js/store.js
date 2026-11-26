// Local-first persistence. Everything lives in this device's localStorage.
import { seedRounds } from './seed.js';

const KEY = 'carry.v1';
export const CLUBS = ['Dr', '3W', '5W', '4H', '4i', '5i', '6i', '7i', '8i', '9i', 'PW', 'GW', 'SW', 'LW', 'Putter'];

function fresh() {
  return {
    profile: { name: 'Golfer', units: 'yd', bag: CLUBS.filter(c => c !== '4i') },
    rounds: seedRounds(),
    active: null,          // id of round in progress
    courses: {},           // saved course layouts (green positions etc.)
    chat: [],
    seeded: true,
  };
}

let state;
try { state = JSON.parse(localStorage.getItem(KEY)) || fresh(); } catch { state = fresh(); }

const saveHooks = new Set();
export const store = {
  get: () => state,
  /** silent = don't notify listeners (used by the sync engine itself) */
  save(silent = false) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage full / private mode */ }
    if (!silent) saveHooks.forEach(f => f());
  },
  update(fn, silent = false) { fn(state); store.save(silent); },
  onSave(fn) { saveHooks.add(fn); },
  reset(withDemo = true) { state = fresh(); if (!withDemo) { state.rounds = []; state.seeded = false; } store.save(); },
  clearDemo() { state.rounds = state.rounds.filter(r => !r.demo); state.seeded = false; store.save(); },
  activeRound: () => state.rounds.find(r => r.id === state.active) || null,
};

export const uid = () => Math.random().toString(36).slice(2, 10);

// Unit helpers: data is stored in yards (feet on the green).
export const toUnit = y => state.profile.units === 'm' ? y * 0.9144 : y;
export const fromUnit = v => state.profile.units === 'm' ? v / 0.9144 : v;
export const fmtD = y => y == null || isNaN(y) ? '—' : Math.round(toUnit(y)) + '';
export const unit = () => state.profile.units === 'm' ? 'm' : 'y';
