const assert = require('node:assert/strict')
const engine = require('../helpers/adapter-engine')
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

it('honours a requested contact count and retains separate closing screws', async () => {
    const input=fixture()
    input.designs.assemblies.case.mount_count=2
    const result=await engine.process(input,{analysis:true})
    assert.equal(result.designs.analysis.case.suggestions.filter(s=>s.kind==='gasket').length,2)
    assert.ok(result.designs.analysis.case.suggestions.some(s=>s.definition.role==='case'))
})

it('counts manual contacts without relocating them and reports excess requests', async () => {
    const input=fixture(), spec=input.designs.assemblies.case
    const initial=(await engine.process(input,{analysis:true})).designs.analysis.case
    const contact=initial.suggestions.find(s=>s.kind==='gasket')
    spec.gaskets={manual:{...contact.definition,placement:{...contact.definition.placement,owner:'manual'}}}
    spec.mount_count=2
    const plan=(await engine.process(input,{analysis:true})).designs.analysis.case
    assert.equal(plan.suggestions.filter(s=>s.kind==='gasket').length,1)
    assert.ok(plan.placements.find(s=>s.id==='manual').position.every((v,i)=>Math.abs(v-contact.position[i])<1e-8))
    spec.mount_count=200
    const crowded=(await engine.process(input,{analysis:true})).designs.analysis.case
    assert.ok(crowded.findings.some(f=>f.code==='mount-count'))
})

it('reuses resolved outlines for mounting edits and invalidates on layout changes', async () => {
    const input=fixture(), cache={}, g=require('../../src/designs/geometry'), original=g.describe
    let descriptions=0
    g.describe=(...args)=>{ descriptions++; return original(...args) }
    try {
        await engine.process(input,{analysis:true,analysisCache:cache})
        const first=descriptions
        input.designs.assemblies.case.mount_count=2
        const result=await engine.process(input,{analysis:true,analysisCache:cache})
        assert.equal(descriptions,first)
        assert.equal(result.designs.analysis.case.suggestions.filter(s=>s.kind==='gasket').length,2)
        input.designs.profiles.board.clearance=3
        await engine.process(input,{analysis:true,analysisCache:cache})
        assert.ok(descriptions>first)
    } finally { g.describe=original }
})

it('limits tray supports to the requested count of existing PCB holes', async () => {
    const input=fixture(), spec=input.designs.assemblies.case
    spec.mounting='tray';spec.mount_count=1;spec.board={source:'asset',name:'board.kicad_pcb'}
    const source='(kicad_pcb (general (thickness 1.6)) (gr_rect (start 0 0) (end 80 40) (layer "Edge.Cuts")) '+[10,70].map((x,i)=>`(footprint "MountingHole:M2" (layer "F.Cu") (at ${x} 20) (property "Reference" "H${i}") (pad "" np_thru_hole circle (at 0 0) (size 2.2 2.2) (drill 2.2)))`).join(' ')+')'
    const result=await engine.process(input,{analysis:true,assets:{'board.kicad_pcb':source}})
    assert.equal(result.designs.analysis.case.suggestions.filter(s=>s.definition.role==='pcb').length,1)
    assert.equal(result.designs.boards.case.holes.length,2)
})

describe('Gasket support spans', () => {
    it('keeps flat contacts clear of short steps and curved corners', () => {
        const m = require('makerjs')
        const suggest = require('../../src/designs/mounts').suggest
        const base = {paths: {step:new m.paths.Line([0,0],[12,0]), arc:new m.paths.Arc([0,20],20,0,90)}}
        const candidates = suggest({profile:'board',suggest:{gaskets:{spacing:40,size:[10,6]}}}, {
            base, exterior:new m.models.Rectangle(100,100), units:{}, name:'case', mounts:{}, exclusions:[],components:[],gasketModels:[],height:24,
            shape: def => m.model.moveRelative(new m.models.Rectangle(10,6),def.anchor.shift)
        })
        assert.deepEqual(candidates, [], 'Short steps and arcs are not flat support spans')
    })
})
