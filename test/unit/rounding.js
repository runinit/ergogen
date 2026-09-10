const assert = require('node:assert/strict')
const engine = require('../../src/ergogen')
const g = require('../../src/designs/geometry')

it('rounds a splayed matrix cavity into closed contours', async function () {
    this.timeout(10000)
    const columns = ['c1', 'c2', 'c3', 'c4', 'c5']
    const rows = ['r1', 'r2', 'r3', 'r4']
    const objects = Object.fromEntries(columns.flatMap(column => rows.map(row => [
        `${column}_${row}`, {kind: 'key', cluster: 'matrix', cell: [column, row], envelopes: {keycap: {size: [18, 18]}}}
    ])))
    // Restoring a removed cell must not make the cavity depend on insertion order.
    const restored = objects.c3_r1
    delete objects.c3_r1
    objects.c3_r1 = restored
    const result = await engine.process({
        schema: 'ergogen/v1',
        layout: {objects, clusters: {matrix: {arrangement: {type: 'columns', columns, rows, pitch: [20, 19], splay: {c3: 2}}}}},
        designs: {
            regions: {keys: {select: {kind: 'key'}, envelope: 'keycap', close: 2}},
            boundaries: {edge: {from: ['regions.keys'], clearance: 2, simplify: 2, corners: {fillet: 1}, connected: 'single'}},
            profiles: {board: {from: 'boundaries.edge'}}
        }
    }, {analysis: true})
    const expanded = g.offset(result.designs.features['profiles.board'].model, 2.6)
    const cavity = g.round(expanded, 2.5)
    assert.equal(g.validate(cavity, 'cavity', 'single'), 1)
})

it('extrudes offset arcs whose chord error is below geometric precision', async () => {
    const {model, args} = require('../fixtures/native/offset-ring.json')
    const kernel = await require('../../src/designs/solid-kernel').open()
    try {
        const solid = kernel.extrude(model, ...args)
        kernel.validate(solid)
        assert.ok(kernel.volume(solid) > 0)
    } finally {
        kernel.close()
    }
})

it('extrudes a gasket roof with sub-tolerance offset slivers', async () => {
    const {model, args} = require('../fixtures/native/offset-roof.json')
    const kernel = await require('../../src/designs/solid-kernel').open()
    try {
        const solid = kernel.extrude(model, ...args)
        kernel.validate(solid)
        assert.ok(kernel.volume(solid) > 0)
    } finally {
        kernel.close()
    }
})
