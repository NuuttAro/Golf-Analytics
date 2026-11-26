// Accounts, cloud sync and friends, backed by Supabase.
// The app stays local-first: everything works signed out / offline, and
// changes sync in the background when signed in.
import { store } from './store.js';
import { roundSummary } from './sg.js';

let sb = null;              // Supabase client, null when not configured
let session = null;
let profile = null;
const listeners = new Set();
// kind: 'data' (account or synced data changed) | 'status' (sync indicator only)
const emit = (kind = 'data') => listeners.forEach(f => { try { f(kind); } catch { /* view gone */ } });

export const cloud = {
  get enabled() { return !!sb; },
  get user() { return session?.user || null; },
  get token() { return session?.access_token || null; },
  get profile() { return profile; },
  status: 'idle',           // idle | syncing | error | offline
  lastSync: null,
  recovery: false,          // true after following a password-reset link
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

export async function initCloud() {
  let cfg = {};
  try { cfg = (await import('/config.js')).default || {}; } catch { /* no config served */ }
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return;
  try {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
    await connect(createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }));
  } catch { /* offline on first load: stay local */ }
}

/** Attach a Supabase client (exported so tests can pass an in-memory fake). */
export async function connect(client) {
  sb = client;
  const { data } = await sb.auth.getSession();
  await setSession(data.session);
  sb.auth.onAuthStateChange(async (event, s) => {
    if (event === 'PASSWORD_RECOVERY') { cloud.recovery = true; location.hash = 'account'; }
    if (event === 'TOKEN_REFRESHED') { session = s; return; }
    await setSession(s);
  });
  store.onSave(scheduleSync);
  addEventListener('online', () => scheduleSync(0));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(0); });
  emit();
}

async function setSession(s) {
  const prevId = session?.user?.id;
  session = s;
  if (!s) { profile = null; emit(); return; }
  if (prevId === s.user.id && profile) return;
  const { data } = await sb.from('profiles').select('*').eq('id', s.user.id).maybeSingle();
  profile = data;
  adoptAccount();
  emit();
  scheduleSync(0);
}

/** First sync for this account on this device (or after local data was erased):
 *  start bookkeeping fresh. Rounds played while signed out are kept and uploaded. */
function adoptAccount() {
  const st = store.get();
  if (st.sync?.userId === session.user.id) return;
  st.sync = { userId: session.user.id, pushed: {}, coursesPushed: {}, profilePushed: null, lastPull: null, deleted: [] };
  const hadDemo = st.rounds.some(r => r.demo);
  st.rounds = st.rounds.filter(r => !r.demo); st.seeded = false;
  // Take the account's saved settings; a brand-new account has no bag yet, so
  // leave profilePushed unset and this device's bag gets uploaded on the next sync.
  if (profile?.bag?.length) { st.profile.units = profile.units; st.profile.bag = profile.bag; st.sync.profilePushed = profileHash(st.profile); }
  store.save(true);
  if (hadDemo) cloud.notice = 'Demo rounds removed — your stats now use your own rounds.';
}

// ---------- auth ----------
export async function usernameAvailable(name) {
  const { data, error } = await sb.rpc('username_available', { name });
  if (error) throw error; return data;
}
export async function signUp({ email, password, username, displayName }) {
  const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username: username.toLowerCase(), display_name: displayName || username }, emailRedirectTo: location.origin } });
  if (error) throw error;
  return { needsConfirm: !data.session };
}
export async function signIn({ email, password }) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}
export async function resetPassword(email) {
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/#account' });
  if (error) throw error;
}
export async function setNewPassword(password) {
  const { error } = await sb.auth.updateUser({ password });
  if (error) throw error;
  cloud.recovery = false;
}
export async function signOut() {
  await syncNow().catch(() => {});
  await sb.auth.signOut();
  // Don't leave this player's rounds on a possibly shared phone.
  store.update(st => {
    const synced = new Set(Object.keys(st.sync?.pushed || {}));
    st.rounds = st.rounds.filter(r => !synced.has(r.id));
    if (st.active && synced.has(st.active)) st.active = null;
    for (const id of Object.keys(st.sync?.coursesPushed || {})) delete st.courses[id];
    st.chat = []; st.sync = null;
  }, true);
  emit();
}
export async function updateProfile(fields) {
  const { data, error } = await sb.from('profiles').update(fields).eq('id', cloud.user.id).select().single();
  if (error) throw error; profile = data; emit();
}

// ---------- sync ----------
function hash(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36) + str.length; }
const roundHash = r => hash(JSON.stringify(r));
const profileHash = p => hash(p.units + '|' + p.bag.join(','));

let timer = null, running = null;
function scheduleSync(delay = 2500) {
  if (!sb || !session) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow().catch(() => {}), delay);
}

export function markDeleted(id) {
  const st = store.get();
  if (st.sync?.pushed?.[id]) { st.sync.deleted.push(id); delete st.sync.pushed[id]; }
}

export async function syncNow() {
  if (!sb || !session) return;
  if (!navigator.onLine) { cloud.status = 'offline'; emit('status'); return; }
  if (running) return running;
  running = (async () => {
    cloud.status = 'syncing'; emit('status');
    try { adoptAccount(); await pull(); await push(); cloud.status = 'idle'; cloud.lastSync = new Date(); }
    catch (e) { cloud.status = 'error'; cloud.error = e.message; }
    finally { running = null; emit('status'); }
  })();
  return running;
}

async function pull() {
  const st = store.get(), sy = st.sync, me = session.user.id;
  let q = sb.from('rounds').select('id,data,deleted,updated_at').eq('user_id', me).order('updated_at').limit(1000);
  if (sy.lastPull) q = q.gt('updated_at', sy.lastPull);
  const { data, error } = await q; if (error) throw error;
  let changed = false;
  for (const row of data) {
    const i = st.rounds.findIndex(r => r.id === row.id);
    const local = st.rounds[i];
    if (row.deleted) { if (local) { st.rounds.splice(i, 1); if (st.active === row.id) st.active = null; changed = true; } delete sy.pushed[row.id]; }
    else if (!local) { st.rounds.push(row.data); sy.pushed[row.id] = roundHash(row.data); changed = true; }
    else if (sy.pushed[row.id] === roundHash(local) || !sy.pushed[row.id]) {
      // local copy hasn't changed since our last sync → take the server's version
      if (roundHash(row.data) !== roundHash(local)) { st.rounds[i] = row.data; changed = true; }
      sy.pushed[row.id] = roundHash(row.data);
    }
    sy.lastPull = row.updated_at;
  }
  if (changed) st.rounds.sort((a, b) => b.date.localeCompare(a.date));

  const cq = sb.from('user_courses').select('course_id,data,updated_at').eq('user_id', me);
  const { data: courses, error: ce } = await (sy.lastCoursePull ? cq.gt('updated_at', sy.lastCoursePull) : cq);
  if (ce) throw ce;
  for (const c of courses) {
    const local = st.courses[c.course_id];
    if (!local || sy.coursesPushed[c.course_id] === hash(JSON.stringify(local))) { st.courses[c.course_id] = c.data; sy.coursesPushed[c.course_id] = hash(JSON.stringify(c.data)); changed = true; }
    sy.lastCoursePull = c.updated_at;
  }
  if (changed) { store.save(true); emit(); }
}

async function push() {
  const st = store.get(), sy = st.sync;
  const rows = [];
  for (const r of st.rounds) {
    if (r.demo) continue;
    const h = roundHash(r);
    if (sy.pushed[r.id] === h) continue;
    const complete = r.holes.length && r.holes.every(x => x.holed);
    rows.push({ row: { id: r.id, date: r.date, course: r.course, data: r, summary: complete ? summaryFor(r) : null, visibility: r.visibility || 'friends', deleted: false }, h });
  }
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25);
    const { error } = await sb.from('rounds').upsert(chunk.map(x => x.row));
    if (error) throw error;
    chunk.forEach(x => { sy.pushed[x.row.id] = x.h; });
  }
  if (sy.deleted.length) {
    const ids = [...sy.deleted];
    const { error } = await sb.from('rounds').update({ deleted: true }).in('id', ids);
    if (error) throw error;
    sy.deleted = sy.deleted.filter(id => !ids.includes(id));
  }
  for (const [id, c] of Object.entries(st.courses)) {
    const h = hash(JSON.stringify(c));
    if (sy.coursesPushed[id] === h) continue;
    const { error } = await sb.from('user_courses').upsert({ course_id: id, data: c });
    if (error) throw error;
    sy.coursesPushed[id] = h;
  }
  const ph = profileHash(st.profile);
  if (sy.profilePushed !== ph) {
    const { error } = await sb.from('profiles').update({ units: st.profile.units, bag: st.profile.bag }).eq('id', session.user.id);
    if (error) throw error;
    sy.profilePushed = ph;
  }
  store.save(true);
}

function summaryFor(r) {
  const s = roundSummary(r);
  const round = v => Math.round(v * 100) / 100;
  return { holes: s.holes, score: s.score, par: s.par, toPar: s.toPar, putts: s.putts, fir: s.fir, firN: s.firN, gir: s.gir, girN: s.girN, penalties: s.penalties, sgTotal: round(s.sgTotal), sg: Object.fromEntries(Object.entries(s.sg).map(([k, v]) => [k, round(v)])) };
}

// ---------- friends ----------
export async function searchUsers(text) {
  const q = text.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (q.length < 2) return [];
  const { data, error } = await sb.from('profiles').select('id,username,display_name').ilike('username', q + '%').neq('id', cloud.user.id).limit(10);
  if (error) throw error; return data;
}

/** { friends:[profile], incoming:[profile], outgoing:[profile] } */
export async function friendships() {
  const me = cloud.user.id;
  const { data, error } = await sb.from('friendships').select('*');
  if (error) throw error;
  const ids = [...new Set(data.map(f => f.requester === me ? f.addressee : f.requester))];
  const people = ids.length ? (await sb.from('profiles').select('id,username,display_name').in('id', ids)).data || [] : [];
  const byId = Object.fromEntries(people.map(p => [p.id, p]));
  const out = { friends: [], incoming: [], outgoing: [] };
  for (const f of data) {
    const other = byId[f.requester === me ? f.addressee : f.requester]; if (!other) continue;
    if (f.status === 'accepted') out.friends.push(other);
    else if (f.addressee === me) out.incoming.push(other);
    else out.outgoing.push(other);
  }
  return out;
}
export async function sendRequest(id) {
  const { error } = await sb.from('friendships').insert({ requester: cloud.user.id, addressee: id });
  if (error && error.code !== '23505') throw error;
}
export async function acceptRequest(id) { const { error } = await sb.rpc('accept_friend', { from_user: id }); if (error) throw error; }
export async function removeFriend(id) {
  const me = cloud.user.id;
  const { error } = await sb.from('friendships').delete().or(`and(requester.eq.${me},addressee.eq.${id}),and(requester.eq.${id},addressee.eq.${me})`);
  if (error) throw error;
}
/** Completed-round summaries for a set of users (RLS limits it to friends + self). */
export async function roundSummaries(userIds, sinceDate) {
  let q = sb.from('rounds').select('id,user_id,date,course,summary').in('user_id', userIds).eq('deleted', false).not('summary', 'is', null).order('date', { ascending: false }).limit(1000);
  if (sinceDate) q = q.gte('date', sinceDate);
  const { data, error } = await q; if (error) throw error; return data;
}
export async function fetchRound(id) {
  const { data, error } = await sb.from('rounds').select('id,user_id,data').eq('id', id).maybeSingle();
  if (error) throw error; return data;
}
