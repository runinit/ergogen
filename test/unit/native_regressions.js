const assert = require('node:assert/strict')
const engine = require('../../src/ergogen')
const g = require('../../src/designs/geometry')

const generated = () => ({
    schema: 'ergogen/v1',
    layout: {objects: {key: {kind: 'key', pcb: 'main', footprints: {switch: {what: 'mx', params: {from: 'C', to: 'R'}}}}}},
    designs: {regions: {board: {shape: {size: [80, 60]}}}, profiles: {board: {from: 'regions.board'}}},
    pcbs: {main: {profile: 'profiles.board'}}
})
const enclosure = () => ({preset: 'enclosure', profile: 'profiles.board', board: {source: 'generated', name: 'main'}, mounting: 'bottom', wall: 3, floor: 2, height: 24, bezel: 10, ledge: {width: 2, thickness: 2}})
const importedBoard = '(kicad_pcb (general (thickness 1.6)) (gr_rect (start -40 -30) (end 40 30) (layer "Edge.Cuts")) (footprint "Review:Controller" (layer "F.Cu") (at 20 0) (property "Reference" "U1") (pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu"))))'
const imported = () => {
    const id = require('../../src/designs/board-inventory').read(importedBoard).components[0].id
    return {
        schema: 'ergogen/v1',
        layout: {
            layers: {floor: {surface: 'case.keyboard.floor', assembly: 'keyboard'}},
            objects: {
                battery: {kind: 'component', layer: 'floor', placement: {at: [-10, 0, 0.2]}, envelopes: {body: {size: [10, 8], height: [0, 2]}}},
                port: {kind: 'component', layer: 'floor', placement: {at: [47, 0, 1]}, envelopes: {service: {size: [20, 6], height: [0, 4]}}}
            }
        },
        designs: {assemblies: {keyboard: {...enclosure(), profile: 'profiles.__pcb_keyboard', board: {source: 'asset', name: 'board.kicad_pcb', components: {[id]: {size: [4, 4], height: [0, 2]}}}}}}
    }
}

describe('Native analysis cache regressions', function() {
    this.timeout(120000)
    it('retains standalone and assembly PCB bytes on repeated cache hits', async () => {
        for (const mode of ['standalone', 'mixed']) {
            const input = generated(), analysisCache = {}
            if (mode === 'mixed') {
                input.pcbs.second = {profile: 'profiles.board'}
                input.designs.assemblies = {keyboard: enclosure()}
            }
            const first = await engine.process(input, {analysis: true, analysisCache})
            for (let repeat = 0; repeat < 2; repeat++) {
                const next = await engine.process(input, {analysis: true, analysisCache})
                assert.deepEqual(next.pcbs, first.pcbs, mode)
            }
        }
    })

    it('retains native blockers once while reusing geometry for mounting edits', async () => {
        const input = generated(), analysisCache = {}
        input.designs.assemblies = {keyboard: enclosure()}
        input.layout.layers = {floor: {surface: 'case.keyboard.floor', assembly: 'keyboard'}}
        input.layout.objects.tall = {kind: 'component', layer: 'floor', envelopes: {body: {size: [6, 6], height: [0, 40]}}}
        input.layout.objects.key.placement = {at: [39, 0, 0]}
        const describe = sinon.spy(g, 'describe')
        const compile = sinon.spy(require('../../src/native/pcbs'), 'compile')
        const first = await engine.process(input, {analysis: true, analysisCache})
        const native = first.layout.findings
        assert.ok(native.some(f => f.code === 'case-height'))
        assert.ok(native.some(f => f.code === 'pcb-pad-outside'))
        const described = describe.callCount
        for (const count of [2, 4, 6]) {
            input.designs.assemblies.keyboard.mount_count = count
            const next = await engine.process(input, {analysis: true, analysisCache})
            assert.deepEqual(next.layout.findings, native)
            for (const finding of native) {
                assert.equal(next.designs.analysis.keyboard.findings.filter(f => f.code === finding.code && f.feature === finding.feature && f.message === finding.message).length, 1)
            }
            next.layout.findings.push({code: 'caller-mutation'})
            next.designs.analysis.keyboard.findings.push({code: 'caller-mutation'})
        }
        assert.equal(describe.callCount, described)
        assert.equal(compile.callCount, 1)
        input.designs.regions.board.shape.size[0] = 100
        const changed = await engine.process(input, {analysis: true, analysisCache})
        assert.ok(!changed.layout.findings.some(f => f.code === 'pcb-pad-outside'))
        assert.equal(compile.callCount, 2)
        await engine.process(input, {analysis: true, analysisCache, assets: {'notes.txt': 'changed'}})
        assert.equal(compile.callCount, 3)
    })
})

describe('Imported boards with native case objects', function() {
    this.timeout(120000)
    const assets = {'board.kicad_pcb': importedBoard}
    it('uses rotated body contours for mounting clearance', async () => {
        const input = imported()
        input.layout.objects.battery.placement.rotate = 45
        const result = await engine.process(input, {analysis:true,assets})
        const model = result.designs.features['components.native_battery'].model
        const perimeter = g.paths(model).reduce((sum,path)=>sum+require('makerjs').measure.pathLength(path),0)
        assert.ok(Math.abs(perimeter - 36) < 0.001, 'A rotated 10 x 8 body keeps its actual contour')
    })
    it('retains imported components and appends native bodies and openings', async () => {
        const result = await engine.process(imported(), {analysis: true, assets})
        const spec = result.designs.analysis.keyboard.parameters
        assert.ok(spec.components.some(ref => ref.startsWith('components.board_')))
        assert.ok(spec.components.includes('components.native_battery'))
        assert.ok(spec.openings.includes('components.service_port'))
        assert.deepEqual(result.designs.features['components.native_battery'].bounds.low, [-15, -4])
        assert.equal(result.pcbs.board, importedBoard)
    })

    it('exports the battery in its mounting frame and subtracts the service opening', async () => {
        const input = imported()
        const result = await engine.process(input, {assets})
        const battery = result.solids.keyboard_components_native_battery
        assert.ok(battery, 'The independently mounted battery must reach solid generation')
        const expected = result.layout.objects.battery.bounds.body
        for (let side = 0; side < 2; side++) {
            for (let axis = 0; axis < 3; axis++) {
                assert.ok(Math.abs(battery.bounds[side][axis] - expected[side][axis]) < 0.01)
            }
        }
        delete input.layout.objects.port
        const closed = await engine.process(input, {assets})
        assert.ok(closed.solids.keyboard_bottom.volume > result.solids.keyboard_bottom.volume + 1)
        assert.equal(result.pcbs.board, importedBoard)
    })
})
