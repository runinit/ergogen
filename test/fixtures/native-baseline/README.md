# BHK baseline

Captured before the native API change: original YAML, canonical configuration,
51 resolved placement points, and KiCad output. `providers.json` contains the 13
pinned footprint modules used by that source, for reproducible offline tests.

Native acceptance compares all original XY/rotation values and all 145 emitted
footprints / 1,122 pads (including net names). KiCad 10's equivalent stroke
syntax is normalized for comparison. Board perimeter geometry intentionally
changes to the explicit native cluster boundary. These fixtures establish
software parity, not electrical or fabrication approval.
