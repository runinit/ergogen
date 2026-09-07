# KiCad 10 validation — September 7, 2026

Status: candidate validation. Registry publication and live GUI proof pending.

## Generator

`@runinit/ergogen@5.0.0` retains the `ergogen` CLI, browser global, and
string-valued PCB results. KiCad 10 is the default; explicit KiCad 5/8 and
custom templates remain supported. Engine-4 configurations require review.

Exact-lock installation (`npm ci`), all 120 tests, coverage, and Rollup build
pass with Node 24.20.0 and npm 11.19.1. Coverage: 99.94% statements, 99.49%
branches, 100% functions, 99.93% lines. Nine focused checks and all 15 historical
PCB snapshots pass. Historical CLI fixtures now explicitly select KiCad 5;
their PCB reference bytes remain unchanged. The initial full suite reproduced
six failures before that fixture correction.

Four measurement regressions failed before extending `test/validation/kicad.py`;
all pass. Measurements include arc midpoints, via drills/types/layer spans,
and zone outlines/holes/fills/layers/nets/connection settings.

## Native acceptance

KiCad 10.0.6 loads, saves, and reloads all nine built-in fixture boards.
Regeneration under the exact dependency lock produces identical board bytes.

Temporary BHK KiCad 8/10 outputs use ceoloide footprints pinned to
`54a23cc9d025ef3a3d1c42b0452d1ceac681ea5a`. BHK source remains unchanged.
Both outputs match expanded geometry and net measurements: 145 footprints,
2,433 copper items, one zone. Saved/reloaded outputs also match each other.
KiCad can shift pad coordinates by 1 nm during saving; this allowance applies
only to the documented pad round trip, not comparisons between templates.

`test/validation/compare.py` verifies all 3,556 connectivity records and all
993 normalized DRC violations match. The existing 206 unconnected items
remain. Normalization removes UUIDs and sorts unordered collections. For
shorting findings only, it removes the summary description, whose net order
varies across identical-file DRC runs; item descriptions retain both net names.
Ratsnest representative choices also vary, so acceptance compares the complete
connectivity graph plus the unconnected count. Other DRC fields are retained.

All 21 Gerbers match after removing creation timestamps.

## Reproduce and inspect

- `npm ci`, `npm test`, `npm run coverage`, `npm run build`
- Focused tests: `node --test test/unit/kicad10.js`
- Historical snapshots: `node test/validation/legacy.js`
- Native fixtures: `node test/validation/generate.js OUTPUT_DIR`
- Geometry and round trip: `python test/validation/kicad.py BOARD SNAPSHOT.json`
- Equivalence: `python test/validation/compare.py BOARD8 BOARD10 DRC8 DRC10`

Local evidence: `/tmp/ergogen-full-tests.log`, `/tmp/ergogen-coverage.log`,
`/tmp/ergogen-build.log`, `/tmp/release-focused.log`, `/tmp/release-legacy.log`,
`/tmp/ergogen-acceptance.log`, `/tmp/runinit-bhk8`, `/tmp/runinit-bhk10`.
GUI evidence and publication gates are tracked in its `RELEASE-KICAD10.md`.
