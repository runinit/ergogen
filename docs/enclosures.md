# Full enclosures

`designs.assemblies.<name>.preset: enclosure` generates connected bottom and top
shells, a switch plate, and reference geometry. The solid model supplies both
STEP and STL. Legacy `cases` and the existing layered presets remain supported.

See [BHK](examples/enclosure-bhk.yaml) for a real layout.
[Footprint tools](footprint-tools.md) documents reusable imports and multiple model
bindings used by board-linked cases.

```yaml
points:
  zones:
    keys:
      columns: {left: {}, right: {}}
      rows: {home: {}, top: {}}
designs:
  regions:
    keys: {where: true, close: 2}
    switches: {where: true, size: 14}
  boundaries:
    body: {from: regions.keys, clearance: 2}
  profiles:
    board: {from: boundaries.body}
  assemblies:
    keyboard:
      preset: enclosure
      profile: profiles.board
      mounting: bottom
      cutouts: [regions.switches]
      wall: 3
      floor: 2
      height: 24
      bezel: 8
      plate: 1.5
      plate_z: 13
      fit: 0.3
      ledge: {width: 2, thickness: 2}
      manufacturing:
        bottom: {process: fdm, nozzle: 0.4, layer: 0.2, orientation: interior-up, supports: allowed}
        top: {process: fdm, nozzle: 0.4, layer: 0.2, orientation: interior-up, supports: allowed}
        plate: {process: fdm, nozzle: 0.4, layer: 0.2, orientation: interior-up, supports: allowed}
```

Dimensions are millimetres and accept Ergogen unit expressions. Example values
are starting points; measure the actual switches, PCB, fasteners and machine.
The minimal example uses a ledge; add closing screws before fabrication.

## Shape and stack

- `profile` is the named board envelope; `plate_profile` can supply a distinct
  plate with existing cutouts. `cutouts` subtracts additional named regions.
  Regions and components accept `corner_radius` for rounded rectangles at their
  declared size. For CNC switch openings use `corner_relief` instead: dogbones
  preserve the nominal rectangle and its retaining edges.
- `wall`, `floor`, `height`, `bezel` and `fit` define continuous walls and a bezel.
  `opening` optionally supplies the bezel opening profile.
- `internal_radius` rounds cavity, gasket-pocket and default opening corners.
  Fit values are minimum clearances; larger tooling radii can enlarge pockets. The report measures
  resulting pocket boundaries; this setting does not certify arbitrary cutouts.
- `plate_z`, `pcb_z` and `pcb_thickness` describe the unrotated stack.
  Set `pcb_profile` to show and check the PCB envelope.
- `typing_angle` rotates the stack. `front_height` sets the front exterior height;
  the bottom is trimmed to a flat datum while retaining its floor.
- `seam: {type: stepped, z: 13, depth: 1, fit: 0.2}` adds a registration lip.
- `fillet` and `chamfer` finish upper edges. Unsupported edge combinations fail
  generation rather than producing a mesh with invalid topology.
- Existing boundary modifications and named bridges remain available in YAML.
  Separate split halves use separate assemblies and profiles.

## Mounting and hardware

`mounting` selects `tray`, `top`, `bottom` or `gasket`. Declare the actual support
locations under `mounts`. The engine retains declared locations. The GUI accepts automatic drafts from
outline analysis and preserves placements marked `placement.owner: manual`.

```yaml
mounts:
  case_left:
    role: case
    anchor: {ref: keys_left_home, shift: [-13, 0]}
    post: 3.5
    hole: 1.1
    depth: 5
    access: top
    hardware: insert
    pocket: 2
    pocket_depth: 3
    min_wall: 1
```

The source uses radii for `post`, `hole` and `pocket`; the wizard displays
**diameters**, or across-flats for a nut pocket. `depth` is the hole depth and
`access` is `top` or `bottom`. Hardware choices are `plain`, `insert`, `nut` and
`tapped`. A nut pocket uses a hexagon; `pocket` is half its across-flats size.
Tapped holes retain `thread` metadata; threads are not helical mesh geometry.

`role: case` closes the shells. `role: pcb` creates lower PCB supports and needs
`pcb_profile`; `role: plate` adds plate tabs and supports. Top mounts attach those
supports to the upper shell, bottom mounts to the lower shell. Tray mounts use
PCB supports. Detached posts and conflicting support volumes are rejected.
A fixed perimeter `ledge: {width: 2, thickness: 2}` is optional.

## Gasket suspension

```yaml
mounting: gasket
gasket:
  kind: pads # or sleeves
  thickness: 2
  compression: 0.2
  fit: 0.2
  travel_up: 0.2
  travel_down: 0.2
  travel_side: 0.1
gaskets:
  left:
    anchor: {feature: profiles.board, shift: [-22, 0]}
    size: [10, 6]
```

Each named contact adds a plate tab, corresponding wall pocket and opposed
support shelves. Pads or sleeves appear as reference solids in their compressed
assembly state. Tabs must overlap the plate and leave material around the pocket.

The plate, PCB and components marked `motion: floating` are checked through the
full declared vertical and lateral movement envelope. Rigid PCB/plate posts and
perimeter ledges are rejected for gasket mounting. Case-closing screws remain
separate. Travel is a clearance check, not a flex or compression simulation.

## Components and openings

Define `designs.components.<name>` with an `anchor`, `size` or `radius`, an
increasing `height: [bottom, top]`, optional `clearance`, and `motion: fixed` or
`floating`. Add the reference to the assembly's `components` list for enclosure
collision checks. Add it to `openings` to subtract its volume from both shells.
This supports controller/connector envelopes, cable exits, batteries and feet.
Only declared envelopes are checked; the generator does not infer populated PCB
component heights from KiCad footprints.

## Manufacturing and export

Choose `manufacturing.bottom`, `.top` and `.plate` separately.

| Process | Settings |
| --- | --- |
| FDM | `nozzle`, `layer`, `min_wall`, `orientation`, `supports`, `build: [x,y,z]`, `material` |
| CNC | `cutter`, `reach`, `min_wall`, `drill`, `setups: [top,bottom]`, `stock: [x,y,z]`, `material` |

Setup directions are relative to the unrotated part. Additional side setups may
be needed for wall openings. Reports check declared envelopes, wall thickness,
actual pocket corner radii, cutter reach, small holes and support requirements.
Sharp switch or custom pocket corners may require relief in the source profile.
The report deliberately blocks those CNC parts until their geometry/process is
changed. Per-feature undercuts, tool holders, fixturing, feeds and cutting paths
still require external CAM. FDM supports and bridge removal require slicer review.

The API returns `solids` and `designs.assemblies` with manufacturing findings.
The CLI writes per-part STEP/STL, named assembly STEP and manufacturing YAML.
Plate outlines also export SVG and DXF. The GUI ZIP includes YAML, outlines,
manufactured solids, reference solids, assembly STEP and manufacturing JSON.

## Kernel and lifecycle

MakerJS lines and arcs become analytic OpenCascade edges. Endpoint joins use the
existing 0.01 mm design tolerance. STEP preserves native solid geometry rather
than wrapping mesh triangles. Each exported manufactured part must be valid,
positive-volume and connected. The adapter owns and releases native handles.
The browser loads CAD WASM on demand; each draft owns a worker that is terminated
on close, with one active generation and only the latest queued draft retained.

Replicad is MIT. The pinned OpenCascade WASM package is LGPL-2.1-only; PlaneGCS
is LGPL-2.0-or-later. Their notices and source references ship with the GUI.


## Guided analysis API

`ergogen.process(config, {analysis: true, assets})` resolves outlines, imported
or generated board inventory, and `designs.analysis.<assembly>` without opening
the CAD kernel. Each plan contains `model`, `exterior`, `bounds`, `edges`,
`placements`, `suggestions`, `findings` and resolved `parameters`. Findings include
severity, source path, affected feature, explanation and suggested repairs.
The normal result retains this analysis alongside existing solids and exports.

Board selection lives under `assemblies.<name>.board`:

```yaml
board:
  source: asset # generated selects a pcbs entry; layout makes a mechanical reference
  name: board.kicad_pcb
  models:
    footprint-uuid:
      asset: models/controller.step
      path: ${KIPRJMOD}/models/models/controller.step
      offset: [0, 0, 0]
      rotate: [0, 0, 0]
      scale: [1, 1, 1]
```

Pass asset contents separately. STL bytes use `base64:` encoding; the GUI caches
converted mesh metadata separately. Association patches affect only the selected
footprint model. Existing nets, pads and routing retain their original text.
Accepted `board.holes` append NPTH footprints only after copper/keepout checks.
Unknown copper graphics prevent accepting a new hole. Layout references have no
electrical routing; select their `family` explicitly (`mx`, `choc-v1`, `choc-v2`).

`construction: cover` retains the top cover and distinct plate.
`construction: midframe` adds a separately exported middle frame with a locating
joint. Supply `manufacturing.middle` for that part. The GUI uses the versioned
`jlccnc-6061-2026-09` preset; its source data and application defaults are recorded
in project metadata. Existing designs keep their declared settings.

The 2D mounting editor stores absolute anchors plus a geometric edge reference.
Changing that edge produces a repairable finding. Redistribute replaces only
entries owned by `automatic`; manual entries are never discarded to fix a fit
conflict. Case-closing M3 hardware shares receiver, clearance and head dimensions.

Model envelopes accept unit expressions. Measured `board.keycaps.size` and
`board.keycaps.height` cover each populated switch; heights use the top of the
switch plate as their datum. Missing keycaps produce an unresolved-clearance
warning. Nonuniform STEP scales retain the original asset and use a faceted
assembly reference with a 0.01 mm meshing tolerance.

Middle frames have clearance bores; case-closing threads belong to the top
cover. Exploded views place that cover above the plate and middle frame.
Screws are separate reference solids; threads remain manufacturing metadata.

### Optional component setup and contact counts

Missing component dimensions are warnings. Their bodies are omitted from the
clearance calculation; successful generation does not validate those bodies.
Known envelopes and supplied model associations still participate normally.

`mount_count` requests a total contact count for the selected mounting system,
including manual contacts. Automatic candidates spread over clear perimeter
spans; closing screws remain separate. If the requested count cannot fit, a
`mount-count` finding reports the available count. Omit it for 40 mm spacing.
Tray mounting distributes the requested supports among existing PCB holes.
More supports require explicit acceptance of suitable new PCB holes.

Worker callers can pass a stable `analysisCache` object with `analysis: true`.
Mount/gasket/spacing/count edits reuse contours. Other configuration or asset
changes invalidate the cache. Solid compilation never uses it.
