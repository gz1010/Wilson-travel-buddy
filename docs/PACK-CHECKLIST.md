# Seville pack: what still needs checking

Recommendations are only as good as this data. Check opening hours against
each place's own website or Google Maps, and fix `app/src/pack/seville/places.json`.
`npm test` in `app/` catches structural mistakes (duplicate IDs, places
outside the map, gaps in the forecast) but not wrong hours.

## Checked on 15 Nov 2026

Main source: the city tourism office's monuments guide, *Monumentos de Sevilla*
(visitasevilla.es, June 2025), winter hours. Then each venue's own site,
OpenStreetMap, and Time Out where the guide doesn't cover a place.

**Closed: marked closed every day, so they are never recommended, and their
summary says why:**

| Place | Status | Source |
|---|---|---|
| hospital-caridad | Closed for restoration until January 2027 | City monuments guide |
| venerables | Closed while it becomes the Cathedral chapter's museum | City monuments guide |
| castillo-san-jorge | Closed for refurbishment (open only as a tourist office) | City monuments guide |
| casa-murillo | "Temporarily closed for works", no dates; not in the city guide | spain.info. **Least certain:** reopen it if you find it open |

**Hours updated:**

| Place | Hours now | Source |
|---|---|---|
| torre-oro | Mon–Fri 09:30–19:00, Sat–Sun 10:30–19:00 | City guide |
| casa-pilatos | Tue–Sun 09:00–18:00; Mon 09:00–14:00, 15:00–17:30 | City guide |
| maestranza | daily 09:30–19:30 (to 15:00 on bullfight days) | City guide |
| salvador | Mon–Sat 10:15–18:00, Sun 14:00–18:00 | City guide |
| museo-flamenco | daily 11:00–18:00 (shows 12:00, 17:00, 19:00, 20:45) | City guide |
| triana-ceramics | Tue–Sun 10:00–19:00, Mon closed | City guide |
| san-luis-franceses | Tue–Sun 10:00–14:00, 16:00–20:00, Mon closed | City guide (winter) |
| gran-poder | Mon–Thu 08:00–13:30, 17:30–21:00; Fri 07:30–22:00; Sat–Sun 09:00–14:00, 17:30–21:00 | City guide |
| santa-ana | Mon–Fri 10:30–19:00; weekends worship only (closed in the pack) | City guide |
| capilla-marineros | Mon–Sat 10:00–13:30, 17:30–21:00; Sun 10:00–14:00, 17:30–20:30 | City guide |
| macarena | Mon–Sat 09:00–14:00, 17:00–21:00; Sun 09:30–14:00, 17:00–21:00 | City guide |
| los-gallos | shows 19:00–20:15 and 20:45–22:00 nightly | tablaolosgallos.com |
| casa-memoria | shows 19:30 and 21:00 daily (about an hour) | andalucia.org |
| tablao-arenal | Tue–Sun from 19:00, Mon closed | Tourist office flamenco listing (2022) |
| las-teresas | daily 10:00–01:00 | lasteresas.es |
| la-campana | daily 08:00–22:00 | Time Out |
| freiduria-puerta-carne | Tue–Sun 13:00–16:00, 20:00–23:30, Mon closed | Two guides agree; not the venue's own |
| mercado-feria | stalls from 09:00; bars to 18:00 Tue–Wed, to midnight Thu–Sat, Sun 13:00–18:00 | visitasevilla.es (older page) |

**Unchanged and confirmed:** archivo-indias (Tue–Sat 09:30–17:00, Sun
10:00–14:00, Mon closed), palacio-duenas (daily 10:00–18:00), bodega-santa-cruz.

**Still estimates, no reliable source found:** la-brunilda (its website was the
only lead), la-fiorentina (website unreachable), universidad, plaza-america,
jardin-delicias. Public spaces (bridges, squares, streets, open gardens) stay
open all day.

Hand-converted from OpenStreetMap: lonja-barranco (public holidays ignored),
palacio-lebrija (September–June hours used).

## Map positions

All 35 places written before the OpenStreetMap script were compared with
OpenStreetMap on 15 Nov 2026. Three were moved to OSM's position:
casa-memoria (142 m off), triana-ceramics (182 m) and bodega-santa-cruz
(82 m). The rest are within about 80 m of the OSM point, mostly the centre of a
large building or square. mercado-feria couldn't be checked (Overpass was
down). Run `node scripts/fetch-places.mjs --compact "<name>"` to get OSM's
values.

## Demo-critical

Hours checked on 14 Nov 2026 for the eight places on the demo route:

| Place | Hours now in the pack | Source |
|---|---|---|
| catedral | Mon–Sat 10:45–18:00, Sun 14:30–19:00 | catedraldesevilla.es (official; was 11:00–17:00) |
| alcazar | daily 09:30–17:00 (Oct–Mar) | several ticket sites agree; official site not reached |
| setas | 09:30–23:00, Fri–Sat to 23:30 | Time Out (was daily to 23:30) |
| bellas-artes | Tue–Sat 09:00–21:00, Sun 09:00–15:00, Mon closed | Junta de Andalucía listings |
| mercado-triana | Mon–Sat 09:00–00:00, Sun 12:00–17:00 | Time Out, Barceló: stalls to 15:00, bars to midnight (was 09:00–15:00, Sun closed) |
| rinconcillo | daily 13:00–01:30 | Time Out |
| plaza-espana | open all day | public square |
| parque-maria-luisa | daily 08:00–22:00 (winter) | Time Out, Visita Sevilla |

Their map pins were compared with OpenStreetMap the same day. Four were moved:
rinconcillo (about 250 m off), parque-maria-luisa (175 m), bellas-artes (120 m)
and mercado-triana (60 m). The other four were within about 30 m.

## Forecast

`forecast.json` is sample data: rain likely (70%) on Sunday 15 Nov from
16:00 to 21:00, which is what feature 2's "done when" check uses, then a
30–40% chance overnight. `node scripts/fetch-forecast.mjs` replaces it with a
real Open-Meteo forecast, but the real one for 14–18 Nov shows no rain, and
the demo shows suggestions changing when rain is forecast. Decide before
recording: keep the sample, or use the real forecast and show the change
another way.

## Facts

37 facts cover 30 places. 12 were added for newer places (shot tower, La
Carbonería, El Comercio, Caridad, Tobacco Factory, Lebrija, Plaza de América,
San Jorge, CAAC, Sailors' Chapel, Gran Poder, Lonja del Barranco), kept to
well-known facts with no uncertain dates. The other places have only their
one-line summary.
