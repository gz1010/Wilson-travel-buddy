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

Check these first; they are on the demo route or in the scripted examples:

- catedral, alcazar, setas, bellas-artes (the Tuesday museum), mercado-triana,
  rinconcillo, plaza-espana, parque-maria-luisa

## Forecast

`forecast.json` is sample data: rain likely (70%) on Sunday 15 Nov from
16:00 to 21:00, which is what feature 2's "done when" check uses, then a
30–40% chance overnight. `node scripts/fetch-forecast.mjs` replaces it with a
real Open-Meteo forecast, but the real one for 14–18 Nov shows no rain, and
the demo shows suggestions changing when rain is forecast. Decide before
recording: keep the sample, or use the real forecast and show the change
another way.

## Facts

Facts exist for 18 places, all from the original 25. The other places have
only their one-line summary for the guide to answer from.
