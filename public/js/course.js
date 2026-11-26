// Course GPS: live location, course lookup from OpenStreetMap, satellite map.
import { haversineYds } from './sg.js';

// Public Overpass servers are often overloaded; ask several and use the first answer.
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];

// ---------- live location ----------
let watchId = null, last = null, simulated = null;
const listeners = new Set();
export function onLocation(fn) { listeners.add(fn); if (current()) fn(current()); return () => listeners.delete(fn); }
export const current = () => simulated || last;
function emit() { const p = current(); listeners.forEach(f => f(p)); }

export function startGps() {
  if (watchId != null || !('geolocation' in navigator)) return;
  watchId = navigator.geolocation.watchPosition(
    p => { last = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() }; emit(); },
    () => { /* denied or unavailable — manual entry still works */ },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
}
export function simulate(p) { simulated = p; emit(); }
export const isSimulated = () => !!simulated;

// ---------- OpenStreetMap lookup ----------
async function overpass(q) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 50000);
  try {
    return await Promise.any(OVERPASS.map(async url => {
      const res = await fetch(url, { method: 'POST', signal: ctl.signal, body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    }));
  } catch { throw new Error('Course service busy — try again'); }
  finally { clearTimeout(timer); ctl.abort(); }
}

export async function findCoursesNear({ lat, lng }, radius = 8000) {
  const j = await overpass(`[out:json][timeout:20];(way["leisure"="golf_course"](around:${radius},${lat},${lng});relation["leisure"="golf_course"](around:${radius},${lat},${lng}););out center tags;`);
  return j.elements.filter(e => e.tags?.name).map(e => {
    const c = e.center || { lat: e.lat, lon: e.lon };
    return { osmId: e.type + '/' + e.id, isCourse: true, name: e.tags.name, lat: c.lat, lng: c.lon, dist: haversineYds({ lat, lng }, { lat: c.lat, lng: c.lon }) };
  }).sort((a, b) => a.dist - b.dist);
}

export async function searchCourses(text) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=' + encodeURIComponent(text + ' golf');
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Search failed');
  const j = await res.json();
  return j.map(e => ({ osmId: e.osm_type + '/' + e.osm_id, isCourse: e.type === 'golf_course', name: e.name || e.display_name.split(',')[0], sub: e.display_name.split(',').slice(1, 3).join(','), lat: +e.lat, lng: +e.lon }))
    .sort((a, b) => b.isCourse - a.isCourse);
}

const centroid = pts => ({ lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length });

/** Load greens, tees, bunkers and hole lines inside the course boundary
 *  (so neighbouring courses don't mix), falling back to a radius search. */
export async function loadCourseLayout({ osmId, isCourse, lat, lng }, radius = 1600) {
  const [type, id] = (osmId || '').split('/');
  const areaId = !isCourse ? null : type === 'way' ? 2400000000 + +id : type === 'relation' ? 3600000000 + +id : null;
  const area = areaId ? `area(${areaId})->.c;` : `is_in(${lat},${lng})->.a;area.a["leisure"="golf_course"]->.c;`;
  let j = await overpass(`[out:json][timeout:25];${area}(way["golf"](area.c);node["golf"="pin"](area.c););out geom tags;`);
  if (!j.elements.some(e => e.tags?.golf === 'hole')) {
    j = await overpass(`[out:json][timeout:25];(way["golf"](around:${radius},${lat},${lng});node["golf"="pin"](around:${radius},${lat},${lng}););out geom tags;`);
  }
  const feats = { green: [], tee: [], bunker: [], fairway: [], water: [], hole: [] };
  for (const e of j.elements) {
    const kind = e.tags?.golf;
    if (!e.geometry || !kind) continue;
    const pts = e.geometry.map(g => ({ lat: g.lat, lng: g.lon }));
    const k = kind === 'water_hazard' || kind === 'lateral_water_hazard' ? 'water' : kind;
    if (feats[k]) feats[k].push({ pts, tags: e.tags });
  }
  const holes = {};
  for (const h of feats.hole) {
    const n = parseInt(h.tags.ref, 10);
    if (!n || n > 27) continue;
    const end = h.pts[h.pts.length - 1];
    const fromCentre = haversineYds({ lat, lng }, centroid(h.pts));
    if (holes[n] && holes[n].fromCentre < fromCentre) continue; // duplicate ref from a neighbouring course
    let green = null, bd = 1e9;
    for (const g of feats.green) { const d = haversineYds(end, centroid(g.pts)); if (d < bd) { bd = d; green = g; } }
    holes[n] = {
      n, fromCentre, par: parseInt(h.tags.par, 10) || null,
      tee: h.pts[0], line: h.pts,
      green: green && bd < 80 ? { center: centroid(green.pts), poly: green.pts } : { center: end, poly: null },
    };
  }
  return { holes, feats };
}

/** Front / centre / back of a green as seen from the player. */
export function greenDistances(pos, green) {
  if (!pos || !green) return null;
  const center = haversineYds(pos, green.center);
  if (!green.poly) return { front: center - 12, center, back: center + 12 };
  // project polygon onto the player→centre line
  const ux = green.center.lng - pos.lng, uy = green.center.lat - pos.lat;
  let lo = Infinity, hi = -Infinity;
  for (const p of green.poly) {
    const t = ((p.lng - pos.lng) * ux + (p.lat - pos.lat) * uy) / (ux * ux + uy * uy);
    lo = Math.min(lo, t); hi = Math.max(hi, t);
  }
  return { front: center * lo, center, back: center * hi };
}

export function insidePoly(p, poly) {
  if (!poly) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.lat > p.lat) !== (b.lat > p.lat) && p.lng < (b.lng - a.lng) * (p.lat - a.lat) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}

// ---------- map ----------
export function createMap(el) {
  const L = window.L;
  const map = L.map(el, { zoomControl: false, attributionControl: true, tap: true }).setView([60.17, 24.94], 16);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery © Esri · Course data © OpenStreetMap',
  }).addTo(map);
  const layers = L.layerGroup().addTo(map);
  const dyn = L.layerGroup().addTo(map);
  return { map, layers, dyn, L };
}
