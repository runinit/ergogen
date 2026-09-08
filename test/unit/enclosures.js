const assert = require('node:assert/strict')
const engine = require('../../src/ergogen')

const fixture = (mounting = 'tray') => ({
    points: {zones: {key: {}}},
    outlines: {source: [{what: 'rectangle', size: [60, 40]}]},
    designs: {
        regions: {board: {outline: 'source'}, switch: {where: true, size: 14}},
        profiles: {board: {from: 'regions.board'}},
        assemblies: {case: {
            preset: 'enclosure', profile: 'profiles.board', mounting,
            wall: 3, floor: 2, height: mounting === 'gasket' ? 24 : 18, plate: 1.5, plate_z: 13,
            bezel: 4, fit: 0.3, cutouts: ['regions.switch'],
            gasket: {kind: 'pads', thickness: 2, compression: 0.2, fit: 0.2,
                travel_up: 0.2, travel_down: 0.2, travel_side: 0.1},
            gaskets: {left: {anchor: {shift: [-30, 0]}, size: [6, 10]}}
        }}
    }
})

describe('Solid enclosures', function() {
    this.timeout(120000)
    for (const mounting of ['tray', 'top', 'bottom', 'gasket']) {
        it(`builds closed top/bottom shells and a plate for ${mounting}`, async () => {
            const result = await engine.process(fixture(mounting))
            for (const name of ['case_bottom', 'case_top', 'case_plate']) {
                assert.ok(result.solids[name].volume > 0)
                assert.match(result.solids[name].step, /MANIFOLD_SOLID_BREP/)
            }
            assert.match(result.designs.assemblies.case.step, /ISO-10303-21/)
            assert.equal(result.designs.assemblies.case.mounting, mounting)
            assert.ok(result.outlines.case_plate.dxf)
        })
    }
    it('offsets a close-spaced four-key layout into continuous walls', async () => {
        const input = fixture()
        input.points = {zones: {keys: {columns: {left: {}, right: {}}, rows: {home: {}, top: {}}}}}
        input.designs.regions.board = {where: true, close: 2}
        input.designs.profiles.board.clearance = 2
        input.designs.assemblies.case.bezel = 8
        const result = await engine.process(input)
        assert.ok(result.solids.case_bottom.volume > 0)
    })
    it('rejects gasket tabs that fill switch cutouts', async () => {
        const input = fixture('gasket')
        input.designs.regions.switch.size = [56, 14]
        await assert.rejects(engine.process(input), /gaskets.left.*cutout/)
    })
    it('rejects a plate mount inside a switch cutout', async () => {
        const input = fixture('top')
        input.designs.regions.switch.size = [56, 14]
        input.designs.assemblies.case.mounts = {key: {role: 'plate', anchor: {shift: [30, 0]}, post: 3, hole: 1}}
        await assert.rejects(engine.process(input), /mounts.key.*cutout/)
    })
    it('rejects insufficient gasket movement clearance', async () => {
        const input = fixture('gasket')
        input.designs.assemblies.case.gasket.travel_down = 8
        await assert.rejects(engine.process(input), /gasket.*travel|movement|clearance/i)
    })
    it('cuts CNC gasket pockets with the requested internal radius', async () => {
        const input = fixture('gasket'), spec = input.designs.assemblies.case
        spec.bezel = 8
        spec.internal_radius = 2
        spec.manufacturing = {bottom: {process: 'cnc', cutter: 3, reach: 30, min_wall: 2, setups: ['top', 'bottom']}}
        const result = await engine.process(input)
        assert.ok(!result.designs.assemblies.case.manufacturing.some(issue => issue.feature.endsWith('.bottom') && issue.code === 'radius'))
    })
    it('reports machining limits without claiming unconfigured features passed', async () => {
        const input = fixture()
        input.designs.assemblies.case.manufacturing = {
            bottom: {process: 'cnc', cutter: 8, reach: 5, min_wall: 4, setups: ['top']}
        }
        const result = await engine.process(input)
        const findings = result.designs.assemblies.case.manufacturing
        assert.ok(findings.some(issue => issue.code === 'reach'))
        assert.ok(findings.some(issue => issue.code === 'wall'))
    })
    it('retains legacy case generation', async () => {
        const input = fixture()
        delete input.designs.assemblies
        input.cases = {legacy: [{name: 'board', extrude: 2}]}
        const result = await engine.process(input)
        assert.ok(result.cases.legacy.jscad)
        assert.equal(result.solids, undefined)
    })
    it('shows sleeve solids and preserves wall material around their pockets', async () => {
        const input = fixture('gasket')
        const spec = input.designs.assemblies.case
        spec.bezel = 8
        spec.gasket.kind = 'sleeves'
        const result = await engine.process(input)
        assert.ok(result.solids.case_gasket_left.volume > 0)
        assert.equal(result.solids.case_gasket_left.reference, true)
    })
    it('adds a mounting tab and insert pocket to a top-mounted plate', async () => {
        const input = fixture('top')
        input.designs.assemblies.case.mounts = {right: {
            role: 'plate', anchor: {shift: [30, 0]}, post: 3, hole: 1,
            hardware: 'insert', pocket: 1.5, pocket_depth: 2, min_wall: 1,
            depth: 4, access: 'bottom'
        }}
        const result = await engine.process(input)
        assert.equal(result.designs.assemblies.case.mounts.right.role, 'plate')
        assert.ok(result.solids.case_top.volume > 0)
        assert.ok(result.solids.case_plate.volume > (60 * 40 - 14 * 14) * 1.5)
    })
    it('opens a top-inserted hardware pocket on the declared face', async () => {
        const input = fixture('top')
        input.designs.assemblies.case.mounts = {right: {
            role: 'plate', anchor: {shift: [30, 0]}, post: 3, hole: 1,
            hardware: 'insert', pocket: 1.5, pocket_depth: 2, min_wall: 1, depth: 4, access: 'top'
        }}
        const result = await engine.process(input)
        const kernel = await require('../../src/designs/solid-kernel').open()
        try {
            const top = await kernel.import(result.solids.case_top.step)
            const probe = kernel.extrude({paths: {circle: new (require('makerjs').paths.Circle)([31.25, 0], 0.1)}}, 0.5, 17)
            assert.ok(kernel.volume(kernel.intersect(top, probe)) < 0.000001)
        } finally { kernel.close() }
    })
    it('extends the floor to the datum when front height increases', async () => {
        const input = fixture()
        input.designs.assemblies.case.front_height = 24
        const result = await engine.process(input)
        assert.ok(Math.abs(result.solids.case_bottom.bounds[0][2]) < 0.000001)
        assert.ok(Math.abs(result.solids.case_top.bounds[1][2] - 24) < 0.000001)
    })
    it('keeps the bottom flat while tilting the mechanical stack', async () => {
        const input = fixture()
        input.designs.assemblies.case.typing_angle = 6
        const result = await engine.process(input)
        assert.ok(Math.abs(result.solids.case_bottom.bounds[0][2]) < 0.001)
        assert.ok(result.solids.case_plate.bounds[1][2] - result.solids.case_plate.bounds[0][2] > 1.5)
    })
    it('builds the complete BHK boundary as valid solids', async () => {
        const fs = require('node:fs')
        const path = require('node:path')
        const yaml = require('js-yaml')
        const input = yaml.safeLoad(fs.readFileSync(path.join(__dirname, '../../docs/examples/enclosure-bhk.yaml'), 'utf8'))
        const result = await engine.process(input)
        assert.ok(result.solids.bhk_bottom.volume > 0)
        assert.ok(result.solids.bhk_top.volume > 0)
        const spec = input.designs.assemblies.bhk
        spec.mounting = 'gasket'
        spec.pcb_profile = 'profiles.pcb'
        spec.gaskets = Object.fromEntries(result.designs.assemblies.bhk.suggestions
            .filter(item => item.kind === 'gasket').slice(0, 4).map(item => [item.id, item.definition]))
        const floating = await engine.process(input)
        assert.ok(floating.solids.bhk_pcb.reference)
        assert.ok(floating.solids.bhk_top.volume > 0)
        spec.mounts = Object.fromEntries(floating.designs.assemblies.bhk.suggestions
            .filter(item => item.kind === 'mount').slice(0, 4).map(item => [item.id, item.definition]))
        const fastened = await engine.process(input)
        assert.ok(fastened.solids.bhk_bottom.volume > 0)
    })
})

module.exports = {fixture}
