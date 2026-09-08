# Parametric designs

`designs` is optional. It runs after outlines and before cases and PCBs.
Existing configurations keep the same pipeline. See [the complete example](examples/designs.yaml)
and `bhk/examples/parametric-case.yaml` in this workspace.

```yaml
designs:
  regions:
    keys: {where: true, close: 2}
    switches: {where: true, size: 14}
  boundaries:
    body: {from: regions.keys, clearance: 3}
  profiles:
    pcb: {from: boundaries.body}
    plate: {from: boundaries.body, cutouts: [regions.switches]}
  assemblies:
    tray:
      preset: tray
      profile: profiles.pcb
      floor: 2
      wall: 3
      height: 10
      fit: 0.3
```

Names are stable references, such as `regions.keys`, `boundaries.body`, and
`profiles.pcb`. Profile names become normal exported outline names. Generated
part names are `<assembly>_<part>`. Output collisions and cyclic references fail
with a feature path. Renaming or removing a referenced feature requires repairing
its references; generated vertex numbers are never references.

## Regions and boundaries

Regions use existing `where` filters and `asym` rules. Rectangles use each key's
actual width, height, position, and rotation. `size` overrides those dimensions;
a scalar makes a square. Skipped keys are excluded. An `outline` region reuses an
existing outline, including its holes. Component regions can use an anchor filter
and explicit `size`.

`close` is a morphological closing radius in millimetres: expand occupied areas,
union, then contract. Gaps narrower than twice the radius can close. Exact tangencies may use a
0.001 mm regularization within the 0.01 mm geometry tolerance. Mirrored
halves close independently, including in derived profiles. Clearance cannot join
separated regions without a named bridge. `clearance` offsets the result; `round` performs an
opening to round exterior corners. Excessive rounding, open or intersecting
contours, and removal of occupied area are errors. `connected: single` requires
one exterior contour; multiple contours are otherwise allowed. Clearance checks
use analytic Boolean geometry. Numerical contour matching follows Maker.js;
Bézier approximation uses a maximum chord error of **0.01 mm**.

Boundaries and profiles accept one `from` reference or an array. Each source is
closed independently; explicit bridges connect separated regions:

```yaml
bridges:
  thumb:
    from: {ref: matrix_inner_home}
    to: {ref: thumb_home}
    width: 12
modifications:
  connector_bulge:
    anchor: {ref: controller, shift: [0, 5]}
    size: [20, 8]
    operation: add
```

Bridge endpoints must be inside their regions. Local modifications use `size`
or `radius`, an existing key `anchor`, and `operation: add|subtract|intersect`.
They may instead use `from: sketches.named_shape`. This supports anchored straight
sections, arcs, and curves. Recesses cannot remove occupied areas. Intentional
switch/stabilizer/component holes belong in a profile's `cutouts` list.

An anchor may also use `{feature: regions.keys, shift: [x, y], rotate: angle}`.
Its origin is the referenced feature's bounding-box center. Accepted mount
suggestions use this representation; they remain editable declarations.

## Sketches and constraints

Points, entities, and constraints have independent names:

```yaml
sketches:
  bracket:
    points:
      origin: {at: [0, 0], fixed: true}
      tip: {at: [20, 3]}
    geometry:
      edge: {type: line, points: [origin, tip], construction: true}
    constraints:
      level: {type: horizontal, line: edge}
      length:
        type: distance
        points: [origin, tip]
        value: {target: 20, min: 18, max: 22, priority: 2}
```

A point can declare an existing key `anchor`; `at` then specifies a local offset.
Lines have two named points. Cubic Béziers have four: start, two controls, end.
Circles use `center` and `radius`. Arcs use `center`, `start`, `end`, and `radius`;
they travel counterclockwise. Construction entities participate in solving but
are excluded from profiles. Exported sketch geometry must form closed contours.
Lines and arcs remain analytic in SVG/DXF; cubic Béziers use adaptive subdivision.

| Constraint | References and dimension |
| --- | --- |
| coincident | `points: [a, b]` |
| horizontal, vertical | `line: edge` |
| parallel, perpendicular, equal_length | `lines: [first, second]` |
| angle | `lines: [first, second]`, `value` in degrees |
| distance | `points: [a, b]`, `value` in mm |
| radius | `geometry: circle_or_arc`, `value` in mm |
| equal_radius | `geometry: [first, second]`; list circle before arc |
| symmetric | `points: [a, b]`, `line: axis` |
| tangent | `line: edge`, `curve: circle_or_arc`; Béziers add `at: start|end`. Circle/arc pairs use `curves: [first, second]` |
| fixed | `point: named_point` |

Dimensions are hard constraints unless their `value` declares `target`, `min`,
`max`, and positive `priority`. PlaneGCS solves flexible dimensions as weighted
temporary constraints. Every fixed residual and permitted range is checked after
solving. An out-of-range optimum is rejected rather than silently clamped. The
report exposes actual adjustments. Coordinates and dimensions support Ergogen
unit expressions. WASM loads only when a sketch is evaluated and solver instances
are destroyed after each solve.

PlaneGCS is LGPL software. Its unmodified npm dependency remains independently
loadable; see [license and attribution](third-party/README.md).

## Assemblies

| Preset | Outputs |
| --- | --- |
| plate | Cut plate, optional gasket tabs |
| tray | Floor, walls, mounting posts; optional separate lid |
| stacked | Named layers with shared mounting holes |
| gasket | Bottom shell, plate with tabs, top shell, ledges and pockets |

All parts compile to normal case operations and JSCAD scripts. The GUI's existing
converter produces separate STL files. `profile` names a closed, single-contour
feature. Explicit dimensions are recommended: `floor`, `wall`, `height`, `plate`,
`fit`, and optional `lid` thickness. Defaults are 2, 3, 10, 1.5, and 0 mm
respectively; no lid is generated unless specified. `height` excludes the floor.

```yaml
mounts:
  screw_left:
    anchor: {ref: matrix_left_home, shift: [-8, 0]}
    hole: 1.2
    post: 3
    height: 5
layers:
  bottom: {thickness: 2}
  spacer: {thickness: 6, cavity: true}
  top: {thickness: 2, cavity: true}
gasket: {thickness: 2, compression: 0.2, fit: 0.2}
gaskets:
  tab_left:
    anchor: {ref: matrix_left_home, shift: [-9, 0]}
    size: [5, 10]
```

Mount `hole` and `post` are radii; matching holes use the same anchor through every
part. Posts must fit inside the exterior and below the lid. Gasket `compression`
is a fraction in `[0, 1)`; compressed thickness sets the pocket/ledge spacing.
Tabs must overlap the plate and fit inside the exterior. Layers may specify their
own `profile`. Assembly `cutouts` references switch, stabilizer, or component
profiles. Set dimensions to match the actual hardware; these defaults are not
fabrication specifications.

`components` contains anchored `size` or `radius` envelopes with explicit
`height: [bottom, top]` ranges and optional clearance. An assembly's `components`
list enables material/envelope collision checks. Its `openings` list subtracts
component envelopes at their height ranges. `exclusions` rejects mounting envelopes
in named geometry. `suggest: {spacing: 30, inset: 5, post: 2.5}` proposes mount
positions on an inset contour, excludes declared components, and never installs
them automatically. Optional `hole` and `height` set suggested screw dimensions.
Add `suggest.gaskets: {spacing: 30, size: [12, 4]}` for oriented tab suggestions
along available edges. Existing mounts, tabs, components, and exclusions limit
suggestions. Accepted suggestions retain their named anchors and dimensions.
Review accepted dimensions in YAML.

## Visual editing and validation

Open **Design** beside Generate. Select a feature to edit its parameters. Sketch
tools place named points; handles edit initial coordinates and the next worker
result applies constraints. The constraint form accepts comma-separated named
references and either a formula or a flexibility mapping for its dimension.
Fixed points cannot be dragged. Anchored dragging updates local offsets, including
rotation and mirroring, without detaching the anchor. Measured dimensions appear
on the canvas and can be edited below it. Pan, zoom, and Fit control the view.
Conversion to an independent sketch is explicit and leaves the source feature
intact. Construction checkboxes control export inclusion.

Visual edits use YAML document ranges and Monaco edit transactions, preserving
unrelated source bytes and participating in editor undo/redo. Formula coordinates
receive additive deltas. Collection replacement and alias detachment are rejected
rather than losing comments or inheritance. Failed generations keep the last valid
preview, mark it stale, and disable current-result downloads. Design results are
published only after every requested STL conversion succeeds. Superseded worker
responses cannot replace current geometry.

Select an assembly for a 3D preview; select individual parts or use exploded view.
Clearance failures identify the conflicting component in the stale-preview status.

Run the engine tests with `npm test`. Validate representative individual STL parts:

```sh
node ergogen/test/validation/designs.cjs \
  ergogen-gui/public/dependencies/openjscad.js /tmp/design-parts
```

The validator checks positive volume and two incident triangles per welded mesh
edge for each of eight representative parts. Fabricated fit remains a physical
validation step.
