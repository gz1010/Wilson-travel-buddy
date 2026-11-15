# Seville pack: what still needs checking

Recommendations are only as good as this data. Check opening hours against
each place's own website or Google Maps, and fix `app/src/pack/seville/places.json`.
`npm test` in `app/` catches structural mistakes (duplicate IDs, places
outside the map, gaps in the forecast) but not wrong hours.

## Opening hours to verify

Hours are estimates (OpenStreetMap had none) for:

- castillo-san-jorge, las-teresas, la-fiorentina, la-brunilda,
  freiduria-puerta-carne, los-gallos, tablao-arenal, san-luis-franceses,
  gran-poder, santa-ana, capilla-marineros, hospital-caridad, universidad,
  plaza-america, jardin-delicias, casa-murillo
- venerables, macarena

Hand-converted from OpenStreetMap: lonja-barranco (public holidays ignored),
palacio-lebrija (September–June hours used).

The first 25 places (catedral … triana-ceramics) were written by hand from
general knowledge before the OpenStreetMap script existed: check both their
coordinates and their hours. Run
`node scripts/fetch-places.mjs --compact "<name>"` to get OSM's values.

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
