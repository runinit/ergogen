const assert = require('node:assert/strict')
const engine = require('../../src/ergogen')
const fixture = () => ({points: {zones: {keys: {columns: {a: {}, b: {}, c: {}}, rows: {a: {}, b: {}}}}},
    designs: {regions: {keys: {where: true, close: 2}, switches: {where: true, size: 14, corner_relief: 0.5}},
        profiles: {board: {from: 'regions.keys', clearance: 2}},
        assemblies: {case: {preset: 'enclosure', profile: 'profiles.board', mounting: 'gasket', bezel: 10,
            cutouts: ['regions.switches'], height: 24}}}})
const analyze = async input => (await engine.process(input, {analysis:true,assets:input.__assets})).designs.analysis.case
const accept = (spec, plan) => {
    for (const item of plan.suggestions) {
        const table = item.kind === 'gasket' ? 'gaskets' : 'mounts'
        spec[table] ||= {}
        spec[table][item.id] = {...item.definition, placement:{owner:'automatic'}}
    }
}
describe('Guided mounting drafts', function() {
    this.timeout(120000)
    for (const mounting of ['gasket','top','bottom','tray']) {
        it(`creates usable ${mounting} supports before CAD`, async () => {
            const input=fixture(), spec=input.designs.assemblies.case
            spec.mounting=mounting
            if (mounting === 'tray') {
                spec.board={source:'asset',name:'test.kicad_pcb'}
                input.__assets={'test.kicad_pcb':'(kicad_pcb (general (thickness 1.6)) (gr_rect (start -10 -30) (end 50 12) (layer "Edge.Cuts")) (footprint "MountingHole:M2" (at -5 7) (layer "F.Cu") (attr exclude_from_bom) (property "Reference" "H1") (pad "" np_thru_hole circle (at 0 0) (size 2.2 2.2) (drill 2.2))))'}
            }
            const plan=await analyze(input)
            assert.ok(plan.suggestions.some(item => item.definition.role === 'case'))
            assert.ok(plan.suggestions.some(item => mounting === 'gasket' ? item.kind === 'gasket' : item.definition.role === (mounting === 'tray' ? 'pcb' : 'plate')))
            accept(spec,plan)
            const result=await engine.process(input,{assets:input.__assets})
            assert.ok(result.solids.case_plate.volume>0)
            assert.ok(Object.keys(result.solids).some(key=>key.startsWith('case_screws_')))
        })
    }
    it('retains the candidate set across automatic redistribution', async () => {
        const input=fixture(), spec=input.designs.assemblies.case
        const first=await analyze(input)
        accept(spec,first)
        const again=await analyze(input)
        assert.deepEqual(again.suggestions.map(p=>p.id),first.suggestions.map(p=>p.id))
    })
    it('reports a manual contact in a switch opening without deleting it', async () => {
        const input=fixture(),spec=input.designs.assemblies.case
        spec.gaskets={manual:{anchor:{shift:[0,0]},size:[10,6],placement:{owner:'manual'}}}
        const plan=await analyze(input)
        assert.ok(plan.placements.some(p=>p.id==='manual'))
        assert.ok(plan.findings.some(f=>f.feature.endsWith('gaskets.manual')&&f.code==='clearance'))
    })
})

it('keeps unaccepted PCB hole proposals after including one hole', async function() {
    this.timeout(30000)
    const input=fixture(),spec=input.designs.assemblies.case
    spec.mounting='tray'
    spec.board={source:'asset',name:'test.kicad_pcb'}
    input.__assets={'test.kicad_pcb':'(kicad_pcb (gr_rect (start -15 -35) (end 60 15) (layer "Edge.Cuts")))'}
    const first=await analyze(input)
    assert.ok(first.holeProposals.length>1)
    spec.board.holes=[first.holeProposals[0]]
    const next=await analyze(input)
    assert.ok(next.holeProposals.length>0)
    assert.ok(!next.holeProposals.some(p=>p.id===first.holeProposals[0].id))
})

it('extends the top cover over the gasket contacts while keeping the plate separate',async function(){
    this.timeout(30000)
    const input=fixture(),spec=input.designs.assemblies.case
    accept(spec,await analyze(input))
    const open=await engine.process(input)
    spec.construction='cover'
    const covered=await engine.process(input)
    assert.ok(covered.solids.case_top.volume>open.solids.case_top.volume+1)
    assert.ok(Math.abs(covered.solids.case_plate.volume-open.solids.case_plate.volume)<0.001)
})

it('clears closing screws through the middle frame into the top receiver',async function(){
    this.timeout(30000)
    const input=fixture(),spec=input.designs.assemblies.case
    spec.construction='midframe'
    const plan=await analyze(input);accept(spec,plan)
    const closing=plan.suggestions.find(item=>item.definition.role==='case')
    const result=await engine.process(input)
    const kernel=await require('../../src/designs/solid-kernel').open()
    try {
        const middle=await kernel.import(result.solids.case_middle.step)
        const model={paths:{hole:new (require('makerjs').paths.Circle)(closing.position,1.6)}}
        const probe=kernel.extrude(model,1,14)
        assert.ok(kernel.volume(kernel.intersect(middle,probe))<0.001)
    } finally {kernel.close()}
})

it('keeps every switch opening clear through a CNC top cover',async function(){
    this.timeout(30000)
    const input=fixture(),spec=input.designs.assemblies.case
    spec.construction='cover';spec.internal_radius=2.5
    spec.board={source:'layout',family:'mx',name:'layout'}
    accept(spec,await analyze(input))
    const result=await engine.process(input)
    const kernel=await require('../../src/designs/solid-kernel').open()
    try {
        const top=await kernel.import(result.solids.case_top.step)
        for (const point of result.designs.boards.case.components) {
            const m=require('makerjs'),opening=m.model.moveRelative(m.model.center(new m.models.Rectangle(14,14)),point.position)
            assert.ok(kernel.volume(kernel.intersect(top,kernel.extrude(opening,3,21)))<0.001)
        }
    } finally {kernel.close()}
})

it('reports an unplaceable layout without returning unsafe suggestions',async()=>{
    const input=fixture(),spec=input.designs.assemblies.case
    input.designs.components={block:{anchor:{shift:[0,0]},size:[1000,1000],height:[0,30]}}
    spec.components=['components.block']
    const plan=await analyze(input)
    assert.equal(plan.suggestions.length,0)
    assert.ok(plan.findings.some(f=>f.code==='placement'))
})
it('flags a changed edge reference without moving its manual feature',async()=>{
    const input=fixture(),spec=input.designs.assemblies.case
    spec.gaskets={manual:{anchor:{shift:[-10,0]},size:[6,10],placement:{owner:'manual',edge:'old edge'}}}
    const plan=await analyze(input)
    assert.ok(plan.findings.some(f=>f.code==='edge-reference'))
    assert.deepEqual(plan.placements.find(p=>p.id==='manual').position,[-10,0])
})
