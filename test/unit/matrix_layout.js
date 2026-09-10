const assert = require("node:assert/strict")
const engine = require("../../src/ergogen")
const source = () => ({
    schema: "ergogen/v1",
    layout: {
        clusters: {
            fingers: {
                arrangement: {
                    type: "columns",
                    columns: ["c1", "c2"],
                    rows: ["r1", "r2"],
                    pitch: [19, 19],
                    splay: { c2: 30 }
                }
            }
        },
        objects: {
            a: { kind: "key", cluster: "fingers", cell: ["c1", "r1"] },
            b: { kind: "key", cluster: "fingers", cell: ["c2", "r1"] },
            c: { kind: "key", cluster: "fingers", cell: ["c2", "r2"] }
        }
    }
})
const close = (actual, expected) =>
    assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} != ${expected}`)
it("splays a whole column about its first row", async () => {
    const result = await engine.process(source(), { layoutOnly: true })
    close(result.layout.objects.b.position[0], 19)
    close(result.layout.objects.c.position[0], 9.5)
    close(result.layout.objects.c.position[1], 19 * Math.cos(Math.PI / 6))
})
it("derives shared matrix nets while preserving explicit electrical identities", async () => {
    const config = source()
    config.layout.objects.a.properties = { column_net: "custom" }
    const result = await engine.process(config, { layoutOnly: true })
    assert.equal(result.layout.objects.a.properties.column_net, "custom")
    assert.equal(
        result.layout.objects.b.properties.column_net,
        result.layout.objects.c.properties.column_net
    )
    assert.equal(result.layout.objects.b.properties.column_net, "fingers_c2")
    assert.equal(
        result.layout.objects.a.properties.row_net,
        result.layout.objects.b.properties.row_net
    )
    assert.equal(result.layout.objects.c.properties.row_net, "fingers_r2")
})
it("applies parametric column offsets to every member", async () => {
    const config = source()
    config.units = { shift: 2 }
    config.layout.clusters.fingers.arrangement.offsets = { c2: ["shift", 3, 0] }
    const result = await engine.process(config, { layoutOnly: true })
    close(result.layout.objects.b.position[0], 21)
    close(result.layout.objects.b.position[1], 3)
    close(result.layout.objects.c.position[0], 11.5)
})
