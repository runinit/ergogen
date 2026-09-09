# Native examples

All examples declare `schema: ergogen/v1`.

| Example | Purpose |
| --- | --- |
| `starter.yaml` | One key and named physical envelopes |
| `columns.yaml` | Column arrangement, staggering, and footprint bindings |
| `thumbs.yaml` | Arc thumb cluster and an explicit board bridge |
| `split.yaml` | Mirrored cluster with stable member identities |
| `physical-stack.yaml` | Screen above MCU; independent floor-mounted battery |
| `imported-pcb.yaml` | Enclosure around a supplied KiCad board asset |
| `bhk.yaml` | Preserved electrical placement and an automatic cluster boundary |

Generate with `node src/cli.js docs/examples/native/columns.yaml --svg`.
The imported example requires `board.kicad_pcb` in the asset map or GUI asset
library. BHK requires its custom footprint providers, bundled by the GUI; offline
acceptance tests retain the pinned providers. BHK's unknown component heights
remain warnings and prevent a claim of verified physical clearance.
