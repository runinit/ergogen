const assert = require("node:assert/strict")
const engine = require("../../src/ergogen")

const fixture = () => ({
    schema: "ergogen/v1",
    units: { pitch: 19 },
    parts: { key: { revision: "1", envelopes: { pcb: { size: [18, 18] } } } },
    layout: {
        objects: {
            a: { kind: "key", part: "key" },
            b: {
                kind: "key",
                part: "key",
                placement: { at: [18, 1, 0], solve: ["x", "y"] }
            },
            c: {
                kind: "key",
                part: "key",
                placement: { at: [40, 0, 0], solve: ["x", "y"] }
            }
        },
        constraints: {
            row: { type: "horizontal", refs: ["a", "b", "c"] },
            pitch: { type: "distance", refs: ["a", "b"], value: "pitch" },
            spacing: { type: "equal_spacing", refs: ["a", "b", "c"] }
        }
    },
    designs: {
        regions: { keys: { select: { kind: "key" }, envelope: "pcb" } },
        profiles: { board: { from: "regions.keys", close: 2 } }
    }
})
const close = (actual, expected) =>
    assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} != ${expected}`)

describe("Native layout constraints", function () {
    this.timeout(30000)
    it("solves before geometry and preserves authored expressions", async () => {
        const config = fixture(),
            before = JSON.stringify(config)
        const result = await engine.process(config, {
            analysis: true,
            debug: true
        })
        close(result.layout.objects.b.position[0], 19)
        close(result.layout.objects.c.position[0], 38)
        close(result.points.c.x, 38)
        assert.equal(result.layout.constraints.dof, 0)
        close(result.layout.constraints.dimensions.pitch.actual, 19)
        assert.equal(JSON.stringify(config), before)
    })
    it("returns authored constraint paths for conflicts", async () => {
        const config = fixture()
        config.layout.constraints.other = {
            type: "distance",
            refs: ["a", "b"],
            value: 20
        }
        await assert.rejects(
            engine.process(config, { layoutOnly: true }),
            (error) => {
                assert.ok(
                    error.diagnostics.some(
                        (item) => item.sourcePath === "layout.constraints.pitch"
                    )
                )
                assert.ok(
                    error.diagnostics.some(
                        (item) => item.sourcePath === "layout.constraints.other"
                    )
                )
                return true
            }
        )
    })
    it("moves an arranged cluster rigidly and resolves linked components afterward", async () => {
        const config = fixture()
        config.layout.clusters = {
            thumbs: {
                placement: { at: [30, -20, 0], solve: ["x"] },
                arrangement: { type: "arc", radius: 45, start: 0, step: 30 }
            }
        }
        config.layout.objects.b = {
            kind: "key",
            part: "key",
            cluster: "thumbs",
            index: 0
        }
        config.layout.objects.c = {
            kind: "key",
            part: "key",
            cluster: "thumbs",
            index: 1
        }
        config.layout.objects.button = {
            kind: "component",
            placement: { ref: "b", at: [0, 10, 0] }
        }
        config.layout.constraints = {
            gap: { type: "distance", refs: ["a", "b"], axis: "x", value: 40 }
        }
        const result = await engine.process(config, { layoutOnly: true })
        close(result.layout.clusters.thumbs.position[0], 40)
        close(result.layout.objects.b.position[0], 40)
        close(result.layout.objects.c.position[0], 62.5)
        close(result.layout.objects.button.position[0], 40)
        close(result.layout.objects.button.position[1], -10)
    })
    it("keeps free movement repeatable and reports it", async () => {
        const config = fixture()
        config.layout.constraints = {
            row: { type: "horizontal", refs: ["a", "b", "c"] }
        }
        const first = await engine.process(config, { layoutOnly: true }),
            second = await engine.process(config, { layoutOnly: true })
        assert.equal(first.layout.constraints.dof, 2)
        assert.deepEqual(first.layout.objects, second.layout.objects)
    })
    it("honors locks even when the placement requests solving", async () => {
        const config = fixture()
        config.layout.objects.b.locked = true
        await assert.rejects(
            engine.process(config, { layoutOnly: true }),
            /constraint|solution/i
        )
    })
})

it("solves rotation about a driven origin and resolves named attachments", async () => {
    const config = {
        schema: "ergogen/v1",
        layout: {
            objects: {
                a: { kind: "anchor" },
                b: {
                    kind: "anchor",
                    placement: { at: [20, 0, 0], solve: ["rotate"] },
                    attachments: { tip: { at: [10, 0, 0] } }
                }
            },
            constraints: {
                angle: { type: "angle", refs: ["a", "b"], value: 30 }
            }
        }
    }
    const result = await engine.process(config, { layoutOnly: true })
    close(result.layout.objects.b.rotation, 30)
    close(result.layout.objects.b.position[0], 20)
    config.layout.constraints.angle = {
        type: "angle",
        refs: ["a.origin", "b.tip"],
        value: 45
    }
    const next = await engine.process(config, { layoutOnly: true })
    close(next.layout.objects.b.rotation, 45)
})

it("does not count a repeated alignment against unrelated free movement", async () => {
    const config = fixture()
    config.layout.objects.d = {
        kind: "anchor",
        placement: { at: [60, 0, 0], solve: ["x"] }
    }
    const result = await engine.process(config, { layoutOnly: true })
    assert.equal(result.layout.constraints.dof, 1)
})

it("updates mirrored keys after moving a source cluster", async () => {
    const config = {
        schema: "ergogen/v1",
        layout: {
            clusters: {
                left: {
                    placement: { at: [20, 0, 0], solve: ["x"] },
                    arrangement: { type: "free" }
                },
                right: { mirror: { source: "left", axis: 50 } }
            },
            objects: {
                a: { kind: "anchor" },
                key: {
                    kind: "key",
                    cluster: "left",
                    placement: { at: [10, 0, 0] }
                }
            },
            constraints: {
                position: {
                    type: "distance",
                    refs: ["a", "clusters.left"],
                    axis: "x",
                    value: 30
                }
            }
        }
    }
    const result = await engine.process(config, { layoutOnly: true })
    close(result.layout.objects.key.position[0], 40)
    close(result.layout.objects.right__key.position[0], 60)
})

it("uses origin aliases as live frames, not fixed snapshots", async () => {
    const config = fixture()
    config.layout.constraints = {
        distance: {
            type: "distance",
            refs: ["a", "b.origin"],
            axis: "x",
            value: 25
        }
    }
    const result = await engine.process(config, { layoutOnly: true })
    close(result.layout.objects.b.position[0], 25)
})

it("keeps a solved source and its referenced mirror linked", async () => {
    const config = {
        schema: "ergogen/v1",
        layout: {
            clusters: {
                left: {
                    placement: { at: [20, 0, 0], solve: ["x"] },
                    arrangement: { type: "free" }
                },
                right: { mirror: { source: "left", axis: 50 } }
            },
            objects: {
                a: { kind: "anchor" },
                key: {
                    kind: "key",
                    cluster: "left",
                    placement: { at: [10, 0, 0] }
                }
            },
            constraints: {
                position: {
                    type: "distance",
                    refs: ["a", "right__key"],
                    axis: "x",
                    value: 60
                }
            }
        }
    }
    const result = await engine.process(config, { layoutOnly: true })
    close(result.layout.objects.key.position[0], 40)
    close(result.layout.objects.right__key.position[0], 60)
})
