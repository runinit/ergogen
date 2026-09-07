# KiCad 10 migration

Ergogen 5 defaults to `template: kicad10`. Native boards use format
`20260206`, KiCad 10 layer IDs, and named net references. PCB results remain
strings. Explicit `kicad5`, `kicad8`, and injected templates remain supported.

Configurations declaring `meta.engine: 4.x.x` must be reviewed and changed to
`meta.engine: 5.0.0`. Engine validation remains enforced. To retain the old
default output, also add `template: kicad5` to each PCB. For KiCad 8, explicitly
select `template: kicad8`.

```yaml
meta:
  engine: 5.0.0
points:
  zones:
    key: {}
pcbs:
  board:
    template: kicad10
```

Footprints keep `.index`, `.str`, `local_net`, and existing positioning helpers.
The KiCad 10 backend parses generated fragments, resolves numeric nets through
the board registry, and converts legacy graphic strokes/arcs. Quoted numeric
names remain names. Unknown numeric IDs and malformed fragments are errors with
board and fragment context. Custom raw fragments must be valid S-expressions.

The backend follows the
[KiCad 10.0.6 serializer](https://raw.githubusercontent.com/KiCad/kicad-source-mirror/10.0.6/pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.cpp).

## Release checks

Run independently from this repository:

```sh
npm ci
npm test
npm run coverage
npm run build
npm pack
```

Additional checks:

```sh
node test/unit/kicad10.js
node test/validation/legacy.js
node test/validation/generate.js /tmp/ergogen-native
```

Load generated fixtures in KiCad 10, save/reload them, export SVG and Gerber,
and compare geometry, net assignments, and DRC against explicit KiCad 8 output.
Publishing is a separate action after validation. Publish Ergogen 5.0.0 before
releasing a GUI depending on it.
