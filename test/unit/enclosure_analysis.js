const assert = require('node:assert/strict')
const engine = require('../../src/ergogen')
const fixture = () => ({points: {zones: {keys: {columns: {a: {}, b: {}, c: {}}, rows: {a: {}, b: {}}}}},
    designs: {regions: {keys: {where: true, close: 2}, switches: {where: true, size: 14}},
        profiles: {board: {from: 'regions.keys', clearance: 2}},
        assemblies: {case: {preset: 'enclosure', profile: 'profiles.board', mounting: 'gasket', bezel: 10,
            cutouts: ['regions.switches'], height: 24}}}})
describe('Enclosure analysis before solids', () => {
    it('offers a complete mounting set without any contacts or CAD initialization', async () => {
        const result = await engine.process(fixture(), {analysis: true, debug: true,
            loadCad: () => { throw new Error('Analysis must not load CAD') }})
        const analysis = result.designs.analysis.case
        assert.ok(analysis.suggestions.some(item => item.kind === 'gasket'))
        assert.ok(analysis.suggestions.some(item => item.kind === 'mount' && item.definition.role === 'case'))
        assert.ok(analysis.edges.length)
        assert.equal(Object.keys(result.solids || {}).length, 0)
    })
    it('reports missing mounting as a repairable finding while retaining the outline', async () => {
        const input = fixture()
        delete input.designs.assemblies.case.mounting
        const result = await engine.process(input, {analysis: true, debug: true})
        assert.ok(result.designs.analysis.case.findings.some(item => item.code === 'mounting'))
        assert.ok(result.designs.features['profiles.board'])
    })
    it('keeps a disconnected outline visible and reports the invalid case boundary', async () => {
        const input = fixture()
        input.points.zones.keys.columns.c = {key: {spread: 90}}
        input.designs.profiles.board.clearance = 0
        const result = await engine.process(input, {analysis: true, debug: true})
        assert.ok(result.designs.analysis.case.findings.some(item => item.code === 'disconnected'))
        assert.ok(result.designs.analysis.case.edges.length)
    })
})

describe('CNC switch engagement', () => {
    it('relieves corners without removing the nominal switch opening', async () => {
        const input = fixture()
        input.designs.regions.switches.corner_relief = 0.5
        const result = await engine.process(input, {analysis: true, debug: true})
        const g = require('../../src/designs/geometry')
        const tooling = require('../../src/designs/tooling')
        const relieved = result.designs.features['regions.switches'].model
        delete input.designs.regions.switches.corner_relief
        const nominal = await engine.process(input, {analysis: true, debug: true})
        assert.ok(g.contains(relieved, nominal.designs.features['regions.switches'].model))
        assert.ok(tooling.radius(relieved) >= 0.499)
    })
})

it('returns a source path and repair action for dimension errors', () => {
    assert.throws(()=>require('../../src/designs/geometry').positive(-1,'designs.assemblies.case.wall'), error=>{
        const finding=error.diagnostics[0]
        assert.equal(finding.sourcePath,'designs.assemblies.case.wall')
        assert.equal(finding.explanation,finding.message)
        assert.ok(finding.repairs[0].label)
        return true
    })
})
