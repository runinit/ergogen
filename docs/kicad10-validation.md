# Isolated release continuation — September 7, 2026

Release incomplete; nothing published, pushed, tagged, or deployed.

The `release/kicad10` branch preserves the original dirty generator tree.
Package metadata now names `@runinit/ergogen@5.0.0`, with public scope access
and an explicit `ergogen` CLI mapping. The browser global remains `ergogen`.

Current checks:

- Nine focused tests and all 15 historical snapshots pass again.
- Four measurement regressions were observed failing before extending the
  snapshotter. Arc midpoints, via drill/type/layer spans, and zone outlines,
  holes, fills, layers, nets, and connection settings are now recorded.
  SWIG copper proxies require explicit subtype casts. All four tests pass.
- Nine freshly generated built-in boards load, save, and reload in KiCad
  10.0.6; footprint and copper-item counts survive the round trip.
- Fresh temporary BHK 8/10 outputs match expanded measurements exactly:
  145 footprints, 2,433 copper items, one zone. Saved/reloaded 8/10 outputs
  also match each other. This does not assert unchanged pad coordinates
  between the original and saved board.
- All 21 freshly exported Gerbers match after removing creation timestamps.
- DRC totals and counts by type remain identical: 993 violations and 206
  unconnected items. Full finding equivalence is **unresolved**. Removing
  UUIDs and sorting findings leaves 61 violation and 90 unconnected entries
  unmatched between 8/10. Repeating DRC on the identical KiCad 8 file leaves
  54 and 87 unmatched respectively. Do not equate counts with connectivity
  proof or relax positional tolerances to hide this nondeterminism.

Toolchain: Node 26.8.1 (required Node 24 unavailable in the inspected paths),
pnpm 11.3.0, KiCad 10.0.6. Focused JavaScript checks borrow dependencies from
`/home/chris/01_Projects/ergogen10/bhk/node_modules`; these are not an exact
lockfile installation. Python emits upstream enum-choice assertions; fixture
loading also emits duplicate image-handler diagnostics.

`npm ci` fails with EAI_AGAIN. Full tests, coverage, and build stop because
Mocha, NYC, and Rollup are missing. GitHub DNS also fails; `gh auth status`
reports unusable authentication. npm scope permissions, remote fork access,
version availability, and immutable KiCanvas/infused-kim revisions cannot be
verified. No network or system configuration was changed.

New temporary artifacts use `/tmp/runinit-ergogen10-fixtures/`,
`/tmp/runinit-bhk8/`, `/tmp/runinit-bhk10/`, and
`/tmp/runinit-ergogen-candidate/`. The adjacent release workspace's
`EVIDENCE.json` records hashes and revisions. Its scoped tarball is an offline
check artifact, not a publishable validated candidate.

The original validation record follows for provenance.

---

# KiCad 10 validation — September 7, 2026

Release validation is incomplete. No publish or deployment was performed.

## Passed

- Nine focused generator tests: default/explicit KiCad 10, KiCad 5/8/custom
  templates, routed nets, local nets, empty/escaped/numeric-looking names,
  ordered native arcs, zones, malformed/unresolved references, engine validation.
- All 15 historical PCB snapshots match. Their configurations now explicitly
  select KiCad 5; the KiCad 8 snapshot updates only the generator version.
- All nine built-in footprint fixture boards load and save in KiCad 10.0.6.
- The extracted 5.0.0 package passes the focused tests and legacy snapshots.
- BHK generation uses a temporary copy, with its exact ceoloide submodule
  revision `54a23cc9d025ef3a3d1c42b0452d1ceac681ea5a` populated from a verified
  local checkout. The original BHK repository remains clean.
- BHK KiCad 8/10 outputs match measured footprint/pad positions, rotations,
  sizes, drills, references, copper endpoints/widths/layers, and net names:
  145 footprints and 2,433 copper items.
- Saved/reloaded KiCad 8/10 boards also match each other. KiCad's save step
  shifts some pad coordinates by at most 1 nm and expands wildcard copper
  layer masks identically for both inputs.
- Both BHK DRC runs report 993 violations and 206 unconnected items, with
  identical violation counts by type. This is not a clean DRC result.
- BHK SVG export succeeded; the front-copper image shows the expected key
  matrix, thumb cluster, and controller pads. This is static KiCad export
  inspection, not browser-viewer validation.
- All 21 exported Gerber files match after removing creation timestamps.

## Environment and limits

Shell DNS failed for GitHub and registry.npmjs.org. npm and pnpm offline
installation attempts found incomplete caches. Full `npm test`, coverage, and
bundle build cannot run: Mocha, NYC, and Rollup are unavailable in this checkout.
GUI precommit/build/Playwright also cannot run without the missing packages.

Focused generator checks used read-only dependencies from the existing BHK
installation via `NODE_PATH`: Maker.js 0.18.2, mathjs 15.1.0, js-yaml 3.14.2,
fs-extra 11.3.3, jszip 3.10.1, and yargs 17.7.2. These satisfy declared ranges
but are not the exact lockfile versions. Repeat all checks after `npm ci`.

Three dependency-light GUI regression checks pass: package-copy isolation,
release-specific viewer caches, and default-template deprecation behavior.
They use the installed TypeScript transpiler; the full GUI suite remains pending.

KiCanvas source integration, native named-net viewer support, actionable preview
errors, the final infused-kim pin, GUI lockfile refresh, production-browser QA,
and downloaded-PCB validation remain unfinished. See the GUI's
`RELEASE-KICAD10.md`. The current GUI preparation must not be released.

## Local artifacts

- Candidate package: `/tmp/ergogen-5.0.0.tgz`
- Native built-in boards: `/tmp/ergogen10-native-fixtures/`
- BHK outputs: `/tmp/ergogen10-bhk8/` and `/tmp/ergogen10-bhk10/`
- Geometry snapshots: `/tmp/ergogen10-bhk8.json`, `/tmp/ergogen10-bhk10.json`
- DRC reports: `/tmp/ergogen10-bhk8-drc.json`, `/tmp/ergogen10-bhk10-drc.json`
- Gerbers: `/tmp/ergogen10-bhk8-gerbers/`, `/tmp/ergogen10-bhk10-gerbers/`
- SVGs: `/tmp/ergogen10-bhk-svg/`; rendered front copper:
  `/tmp/ergogen10-bhk-front.png`

`test/validation/generate.js` generates native fixture boards;
`test/validation/kicad.py` records measured geometry and saves a round-trip copy.
