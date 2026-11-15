// OpenStreetMap opening_hours → the pack's hours (core/types.ts OpeningHours), shared by
// fetch-places.mjs and build-nearby.mjs.
// OSM opening_hours → pack hours, for the common simple forms:
// "Mo-Fr 09:00-17:00; Sa 10:00-14:00; Su off", "Mo-Su 10:00-14:00,17:00-20:00", "24/7".

export const OSM_DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
export const PACK_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function expandDays(spec) {
  const out = new Set();
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-');
    const i = OSM_DAYS.indexOf(a);
    const j = b ? OSM_DAYS.indexOf(b) : i;
    if (i < 0 || j < 0) return undefined;
    for (let k = i; ; k = (k + 1) % 7) {
      out.add(k);
      if (k === j) break;
    }
  }
  return [...out];
}

export function convertHours(osm) {
  if (!osm) return undefined;
  const s = osm.trim();
  if (s === '24/7') return { daily: '24h' };
  const hours = {};
  for (const rule of s.split(';').map(r => r.trim()).filter(Boolean)) {
    const m = /^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:,(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)?\s*(.*)$/.exec(rule);
    if (!m) return undefined;
    const days = m[1] ? expandDays(m[1]) : [0, 1, 2, 3, 4, 5, 6];
    const times = m[2].trim().replace(/\s*,\s*/g, ',');
    if (!days) return undefined;
    let value;
    if (times === 'off' || times === 'closed') value = 'closed';
    else if (/^\d{2}:\d{2}-\d{2}:\d{2}(,\d{2}:\d{2}-\d{2}:\d{2})*$/.test(times)) value = times.replace(/24:00/g, '00:00');
    else return undefined; // PH, months, "sunset", comments…: do it by hand
    for (const d of days) hours[PACK_DAYS[d]] = value;
  }
  // In OSM a day no rule mentions is closed; in the pack a missing day means
  // "unknown" and is treated as open, so spell the closed days out.
  for (const d of PACK_DAYS) hours[d] ??= 'closed';
  const values = PACK_DAYS.map(d => hours[d]);
  if (values.every(v => v && v === values[0])) return { daily: values[0] };
  return hours;
}
