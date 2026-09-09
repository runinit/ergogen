# BHK component dimensions

Checked 2026-09-09. Millimetres; nominal dimensions are not fit tolerances.
The native BHK example and GUI gallery share these values.

| Component | Known dimensions | Configuration treatment |
| --- | --- | --- |
| nice!view module | 36 × 14 × 2.9 | `display_body_height: 2.9`; body Z is `[0, display_body_height]`. |
| nice!view supplied sockets | 7 high | `display_socket_height: 7`; separate `display_support` layer above PCB top. Confirm the installed pair matches. |
| SuperMini nRF52840 ProMicro | Existing XY envelope 18 × 33; assembled Z unverified | Body height omitted. USB shell, underside parts, sockets and pins require the actual board revision. |
| THQWGD001C | Designer publishes assembly CAD; installed variant unconfirmed | Body height omitted; existing PCB envelope retained. |
| Power switch PWR1 | PCB support 5 × 8.5, local offset [-0.5, 0] | Covers the existing reversible footprint pads and bosses; body height unknown. |
| Reset button RST1 | PCB support 7 × 4 | Covers the existing reversible footprint pads and bosses; body height unknown. |
| Battery | No cell model specified | No invented cell dimensions or placement. Specify the pack including protection board, leads and connector. |

## Display source and datum

[Nice Keyboards](https://nicekeyboards.com/nice-view/) publishes the module
size and supplied socket height separately. The configuration uses the 7 mm
socket stack as the nominal distance from the host PCB top to the module bottom.
The module top is therefore 9.9 mm above the host PCB top, or Z=17.5 with the
example's PCB bottom at Z=6 and PCB thickness 1.6.

This assumes the supplied sockets. Confirm seating and solder protrusions on the
actual assembly. The body envelope covers the module, not the five socket pins.
Changing `display_socket_height` moves the module without changing electrical
XY placement. It does not certify clearance over an unmeasured SuperMini.

## Unresolved hardware

The [SuperMini vendor wiki](https://wiki.icbbuy.com/doku.php?id=developmentboard:nrf52840)
does not establish the installed module/socket Z envelope for this build.
Do not substitute nice!nano dimensions or the smaller SuperMini Zero board.

The [THQWGD001C designer's repository](https://github.com/Taro-Hayashi/THQWGD001)
contains two-pin/four-pin footprint variants, assembly models, and curved/flat
wheel parts. Source reviewed at `fb66eaee8b8936131eba91c4c5983af2f3b1344a`.
Its 11 mm encoder and 6 × 6 × 7 mm tactile switch specifications describe
subcomponents, not the assembled wheel height. Select the installed variant and
verify its PCB seating datum before assigning an assembly envelope.

The battery connector binding does not identify the battery. A floor-mounted
battery needs its own component and case-floor layer; it must not inherit the
scrollwheel object's location merely because that object emits the connector.

Missing envelopes remain unresolved in clearance checks. Published nominal
values do not replace physical fit validation.

The control support sizes come from the frozen BHK footprint definitions
(`test/fixtures/native-baseline/providers.json`), including pad orientation and
NPTH bosses. They are board-support allowances, not measured body dimensions.
Both controls are independent layout objects; their original placements and
nets remain unchanged.
