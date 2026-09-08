# Design validation

Run from the generator checkout:

```sh
npm run build
npm test
npx mocha test/unit/solid_kernel.js test/unit/enclosures.js test/unit/manufacturing.js
```

Tests include analytic STEP round trips, connected solids, all four mounting
styles, gasket pads/sleeves, insert pockets, tilted cases, machining findings,
BHK geometry, and legacy outputs. Invalid topology, collisions, stale draft
results and source preservation have regression tests.

Run the GUI's unit, release-helper and production browser suites separately.
The browser suite must use the built asset base path, including the separate
preview path. A source test or build alone is not proof of a live deployment.

Generated parts are prototypes. Manufacturing reports use declared dimensions;
physical fit and suspension feel still require fabrication. CAM and slicing are
outside the generator.
