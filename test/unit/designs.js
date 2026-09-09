const engine = require('../helpers/adapter-engine')
const m = require('makerjs')

const config = () => ({
    points: {zones: {keys: {columns: {a: {}, b: {}}, rows: {home: {}}}}},
    designs: {
        regions: {keys: {where: true}},
        boundaries: {board: {from: ['regions.keys'], close: 2, clearance: 1}},
        profiles: {pcb: {from: 'boundaries.board'}}
    }
})

describe('Parametric designs', function() {
    this.timeout(30000)

    it('publishes profiles to the existing outline and case pipeline', async () => {
        const input = config()
        input.cases = {plate: [{name: 'pcb', extrude: 2}]}
        const result = await engine.process(input, {debug: true, svg: true})
        expect(result.outlines.pcb.svg).to.include('<svg')
        expect(result.cases.plate.jscad).to.include('plate_case_fn')
        expect(result.designs.features['boundaries.board'].contours).to.equal(1)
    })

    it('follows rotated, nonstandard keys and formula spacing', async () => {
        const input = config()
        input.points.zones.keys.key = {width: 24, height: 16, spread: 26, splay: 12}
        const first = await engine.process(input, {debug: true})
        input.points.zones.keys.key.spread = 30
        const second = await engine.process(input, {debug: true})
        expect(second.designs.features['profiles.pcb'].bounds.high[0])
            .to.be.greaterThan(first.designs.features['profiles.pcb'].bounds.high[0])
    })

    it('keeps mirrored halves separate during gap closing', async () => {
        const input = config()
        input.points.mirror = 35
        const result = await engine.process(input, {debug: true})
        expect(result.designs.features['boundaries.board'].contours).to.equal(2)
    })

    it('rejects missing references, cycles and output collisions with feature paths', async () => {
        const input = config()
        input.designs.profiles.pcb.from = 'boundaries.missing'
        await expect(engine.process(input)).to.be.rejectedWith('designs.boundaries.missing')
        input.designs.boundaries.board.from = ['profiles.pcb']
        input.designs.profiles.pcb.from = 'boundaries.board'
        await expect(engine.process(input)).to.be.rejectedWith('Cyclic')
        input.designs = config().designs
        input.outlines = {pcb: [{what: 'rectangle', where: true, size: 14}]}
        await expect(engine.process(input)).to.be.rejectedWith('collision')
    })

    it('rejects recesses that remove occupied area', async () => {
        const input = config()
        input.designs.boundaries.board.modifications = {
            notch: {operation: 'subtract', anchor: {ref: 'keys_a_home'}, size: [10, 10]}
        }
        await expect(engine.process(input)).to.be.rejectedWith('modifications.notch')
    })

    it('preserves holes from existing outlines', async () => {
        const input = config()
        input.outlines = {ring: [
            {what: 'rectangle', size: 50},
            {what: 'circle', radius: 5, operation: 'subtract'}
        ]}
        input.designs = {regions: {ring: {outline: 'ring'}}, profiles: {ring_edge: {from: 'regions.ring', clearance: 1}}}
        const result = await engine.process(input, {debug: true})
        expect(m.model.findChains(result.outlines.ring_edge.yaml)).to.have.length(2)
    })
})

describe('Design offset regression', () => {
    it('expands rounded profiles farther than their original corner radius', async () => {
        const input = config()
        input.points = {zones: {key: {}}}
        input.designs = {regions: {keys: {where: true}}, profiles: {pcb: {from: 'regions.keys', clearance: 2}}}
        input.designs.assemblies = {box: {preset: 'tray', profile: 'profiles.pcb', wall: 3}}
        const result = await engine.process(input)
        expect(result.cases.box_tray.jscad).to.include('main')
    })
})

describe('Design rejection diagnostics', () => {
    it('names excessive smoothing and disconnected profile failures', async () => {
        const input = config()
        input.designs.boundaries.board.round = 100
        await expect(engine.process(input)).to.be.rejectedWith('designs.boundaries.board')
        input.designs.boundaries.board.round = 0
        input.designs.boundaries.board.close = 0
        input.designs.boundaries.board.clearance = 0
        input.designs.boundaries.board.connected = 'single'
        await expect(engine.process(input)).to.be.rejectedWith('connected')
    })
})

it('keeps separated halves separate in derived profiles', async () => {
    const input = config()
    input.points.mirror = 35
    input.designs.profiles.pcb.close = 20
    const result = await engine.process(input)
    expect(result.designs.features['profiles.pcb'].contours).to.equal(2)
    input.designs.profiles.pcb.clearance = 10
    await expect(engine.process(input)).to.be.rejectedWith('bridge')
})

it('connects occupied regions through a narrow named bridge and excludes skipped keys', async () => {
    const input = config()
    input.points.zones.keys.key = {spread: 50}
    input.designs.boundaries.board = {from: 'regions.keys', bridges: {neck: {
        from: {ref: 'keys_a_home'}, to: {ref: 'keys_b_home'}, width: 0.5
    }}, connected: 'single'}
    const result = await engine.process(input)
    expect(result.designs.features['boundaries.board'].contours).to.equal(1)
    delete input.designs.boundaries.board.bridges
    input.points.zones.keys.columns.b.key = {skip: true}
    const skipped = await engine.process(input)
    expect(skipped.designs.features['regions.keys'].bounds.high[0]).to.be.lessThan(20)
})

it('rejects smoothing that violates a declared clearance', async () => {
    const input = config()
    input.points = {zones: {key: {}}}
    input.designs.boundaries.board = {from: 'regions.keys', clearance: 3, round: 5}
    await expect(engine.process(input)).to.be.rejectedWith('clearance')
})
