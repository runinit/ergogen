# Footprint inspection, conversion and models

`require('ergogen').footprints` exposes shared helpers used by the GUI and workers.
Existing injection APIs and `{params, body}` CommonJS modules remain compatible.

```js
const fs = require('node:fs')
const {footprints} = require('ergogen')
const original = fs.readFileSync('part.kicad_mod', 'utf8')
const imported = footprints.convert(original, {
    name: 'my_part', mapping: {'1': 'from', '2': 'to'}
})
fs.writeFileSync('footprints/my_part.js', imported.source)
fs.writeFileSync('usage.yaml', imported.yaml)
```

The exported module is self-contained. It exposes `side: F|B`, `designator` and
net parameters; normal Ergogen placement/rotation controls remain available.
Duplicate pad numbers share a parameter. Mechanical pads are not assigned nets.
Original geometry and metadata are embedded, including unsupported constructs.
Unsupported placement transformations fail explicitly.

`inspect(source, target?)` returns pads, net groups, graphics, model references,
diagnostics and emitted targets. A target can use a unique `reference`, `id` or
`name`, or `{index, count}` to guard an explicitly selected output. Multiple outputs
require a target before models can be modified.

```js
const bindings = [{
    path: '${KIPRJMOD}/models/controller.step',
    offset: [0, 0, 1], rotate: [0, 0, 90], scale: [1, 1, 1]
}]
const output = footprints.models(boardText, bindings, {reference: 'U1'})
const moduleSource = footprints.bind(originalModuleSource, bindings, {name: 'Controller'})
```

`models` replaces only model nodes in the selected footprint. Pads, nets, tracks
and unrelated source remain intact. `bind` appends a wrapper around the original
module and transforms the result of `body(p)`; it does not rewrite JavaScript.
An empty list removes all selected model bindings. Existing single bindings remain
accepted. Extra model metadata survives inspection and reapplication.

Modules may alternatively declare `modelBindings`, as a binding/list or a function
of `p`; the PCB pipeline applies it after `body(p)`. Modules without this optional
field retain their existing behaviour.

Offsets use millimetres. Inspection converts legacy `(at (xyz …))` model offsets
from inches; modern `(offset (xyz …))` stays in millimetres. Model rotations follow
KiCad's negative X/Y/Z convention. Board-side transforms happen at placement.

`envelope(models, assets)` unions transformed cached model bounds and returns
`size`, `height` and `body_offset`, or `null` when dimensions are unavailable.
`modelPoint(point, binding)` applies the same local transform. Asset metadata uses
`__model_<asset path>.json` with `bounds: [[minX,minY,minZ],[maxX,maxY,maxZ]]`.

Board associations under `board.models.<reference>` accept lists and legacy single
bindings. Explicit associations override footprint bindings; ordinary library
bindings resolve from their emitted portable paths. Native assembly references
include all cached models as a compound. Original STEP assets remain unchanged;
nonuniformly scaled native references use the existing faceted representation.

`countUses(config, alias)` resolves Ergogen points, inheritance, parameters and
footprint filters to count actual placements. It does not infer links from names;
identity and project-library revision management belong to the GUI service.

See `test/unit/footprint_tools.js` and `test/unit/native_models.js` for conversion,
byte preservation, transforms and native assembly regression coverage.
