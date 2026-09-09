const assert = require('node:assert/strict')
const makerjs = require('makerjs')
const engine = require('../../src/ergogen')
const kernels = require('../../src/designs/solid-kernel')

describe('Native footprint models', function() {
    this.timeout(120000)
    it('exports every cached model from library bindings and explicit instance lists on both sides', async () => {
        const kernel = await kernels.open()
        let cube
        try {
            cube = await kernel.export(kernel.extrude(makerjs.model.center(new makerjs.models.Rectangle(2, 2)), 1), 'cube')
        } finally { kernel.close() }
        const bindings = [-4, 4].map((x, index) => ({asset: 'cube.step', path: '${KIPRJMOD}/models/cube.step', offset: [x, 0, index + 1]}))
        engine.inject('footprint', 'native_model_test', {
            params: {designator: {type: 'string', value: 'U'}, side: {type: 'string', value: 'F'}},
            body: p => `(footprint "test" (layer "${p.side}.Cu") ${p.at} (property "Reference" "${p.ref}") (fp_rect (start -1 -1) (end 1 1) (layer "${p.side}.CrtYd") (stroke (width 0.1) (type default))) ${bindings.map(item => `(model "\${KIPRJMOD}/models/cube.step" (offset (xyz ${item.offset.join(' ')})))`).join(' ')})`
        })
        const input = {
            points: {zones: {key: {}}},
            outlines: {outline: [{what: 'rectangle', size: [60, 40]}]},
            pcbs: {board: {outlines: {edge: {outline: 'outline'}}, footprints: {
                front: {what: 'native_model_test', where: true, adjust: {shift: [-10, 0]}},
                back: {what: 'native_model_test', where: true, adjust: {shift: [10, 0]}, params: {side: 'B'}}
            }}},
            designs: {regions: {board: {outline: 'outline'}}, profiles: {board: {from: 'regions.board'}}, assemblies: {case: {
                preset: 'enclosure', profile: 'profiles.board', mounting: 'gasket', wall: 3, floor: 2,
                height: 24, plate: 1.5, plate_z: 13, bezel: 10, fit: 0.3,
                gaskets: {left: {anchor: {shift: [-30, 0]}, size: [6, 10]}},
                board: {source: 'generated', name: 'board', models: {U2: bindings.map(binding => ({...binding, asset: 'cube.stl', path: '${KIPRJMOD}/models/cube.wrl'}))}}
            }}}
        }
        const result = await engine.process(input, {assets: {
            'cube.step': cube.step,
            'cube.stl': 'base64:' + Buffer.from(cube.stl).toString('base64'),
            'cube.wrl': '#VRML V2.0 utf8',
            '__model_cube.stl.json': JSON.stringify({bounds: cube.bounds}),
            '__model_cube.step.json': JSON.stringify({bounds: cube.bounds})
        }})
        for (const ref of ['U1', 'U2']) {
            const solid = result.solids[`case_components_board_case_${ref}`]
            assert.ok(solid, ref)
            assert.ok(Math.abs(solid.volume - 8) < 0.001, `${ref}: model volume ${solid.volume}, expected 8`)
            assert.ok(Math.abs(solid.bounds[1][0] - solid.bounds[0][0] - 10) < 0.001)
        }
    })
})
