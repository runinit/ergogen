const assert = require('node:assert/strict')
const board = require('../../src/designs/board-inventory')
const source = `(kicad_pcb (version 20260206) (general (thickness 1.2))
(gr_rect (start 0 0) (end 60 40) (layer "Edge.Cuts"))
(footprint "Switch:SW_MX" (layer "B.Cu") (at 20 12 90) (uuid "one")
(property "Reference" "SW1") (fp_rect (start -7 -7) (end 7 7) (layer "B.CrtYd"))
(model "switch.step" (offset (xyz 0 0 1)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 90)))))`
describe('Board inventory', () => {
    it('reads board outline, thickness, flipped switch and model transforms', () => {
        const result = board.read(source)
        assert.equal(result.thickness, 1.2)
        assert.equal(result.components[0].side, 'bottom')
        assert.deepEqual(result.components[0].position, [20, -12])
        assert.equal(result.components[0].models[0].path, 'switch.step')
        assert.equal(result.components[0].models[0].offset[2], 1)
        assert.ok(result.components[0].height)
    })
    it('does not infer an unknown component height', () => {
        const result = board.read(source.replace('Switch:SW_MX', 'Custom:Unknown'))
        assert.equal(result.components[0].height, null)
    })
    it('changes only the chosen model association and preserves pad/net text', () => {
        const updated = board.associate(source, 'one', {path: '${KIPRJMOD}/models/new.step', offset: [0,0,0], scale: [1,1,1], rotate: [0,0,0]})
        assert.ok(updated.includes('${KIPRJMOD}/models/new.step'))
        assert.ok(updated.includes('(property "Reference" "SW1")'))
        assert.ok(updated.startsWith(source.slice(0, source.indexOf('(model'))))
    })
})

it('uses KiCad local pad coordinates once on a flipped and rotated footprint', () => {
    // KiCad 10.0.6 gives this pad the board position (16, 17).
    const data='(kicad_pcb (gr_rect (start 0 0) (end 60 40) (layer "Edge.Cuts")) (footprint "MountingHole:M2" (layer "B.Cu") (at 20 20 90) (property "Reference" "H1") (pad "" np_thru_hole circle (at 3 -4 90) (size 2.2 2.2) (drill 2.2))))'
    assert.deepEqual(board.read(data).holes[0].position,[16,-17])
})
it('rejects proposed holes on copper and accepts clear board material without changing nets', () => {
    const data='(kicad_pcb (net 1 "GND") (gr_rect (start 0 0) (end 60 40) (layer "Edge.Cuts")) (segment (start 10 10) (end 30 10) (width 1) (layer "F.Cu") (net 1)))'
    assert.throws(()=>board.addHole(data,{id:'H1',position:[20,-10],diameter:2.2}),/copper/)
    const changed=board.addHole(data,{id:'H1',position:[40,-30],diameter:2.2})
    assert.ok(changed.startsWith(data.slice(0,-1)))
    assert.equal(board.read(changed).holes.length,1)
})

it('resolves an imported PCB without Ergogen layout points', async () => {
    const input={designs:{regions:{case_keys:{where:true},case_switches:{where:true,size:14}},profiles:{case_board:{from:'regions.case_keys'}},assemblies:{case:{preset:'enclosure',profile:'profiles.case_board',mounting:'bottom',board:{source:'asset',name:'board.kicad_pcb'},cutouts:['regions.case_switches'],height:24,bezel:10}}}}
    const result=await require('../helpers/adapter-engine').process(input,{analysis:true,assets:{'board.kicad_pcb':source}})
    assert.equal(result.designs.boards.case.thickness,1.2)
    assert.ok(result.designs.analysis.case.model)
    assert.equal(result.designs.analysis.case.parameters.cutouts[0],'regions.__switches_case')
})
it('excludes helper points from the layout switch inventory', async () => {
    const input={points:{zones:{keys:{columns:{a:{},b:{}},rows:{home:{}}},helper:{anchor:{shift:[50,0]},key:{tags:['helper']}}}},designs:{regions:{keys:{where:"/^keys_/",close:2}},profiles:{board:{from:'regions.keys'}},assemblies:{case:{preset:'enclosure',profile:'profiles.board',mounting:'top',board:{source:'layout',name:'layout',family:'mx'},height:24,bezel:10}}}}
    const result=await require('../helpers/adapter-engine').process(input,{analysis:true})
    assert.equal(result.designs.boards.case.components.length,2)
})

it('rejects holes inside a rotated footprint keepout', () => {
    const data='(kicad_pcb (gr_rect (start 0 0) (end 60 40) (layer "Edge.Cuts")) (footprint "Test" (layer "F.Cu") (at 30 20 90) (zone (layers "F.Cu" "B.Cu") (keepout (tracks not_allowed)) (polygon (pts (xy -5 -5) (xy 5 -5) (xy 5 5) (xy -5 5))))))'
    assert.equal(board.holeFits(board.read(data),[30,-20],2.2),false)
})
it('reports unsupported board curves instead of accepting a partial outline', () => {
    const data=source.replace('(gr_rect', '(gr_curve (pts (xy 0 0) (xy 1 1) (xy 2 1) (xy 3 0)) (layer "Edge.Cuts")) (gr_rect')
    assert.throws(()=>board.read(data),/unsupported.*Edge.Cuts/i)
})

it('resolves component dimension expressions before calculating stack heights', async()=>{
    const input={units:{body:2},points:{zones:{keys:{}}},designs:{regions:{keys:{where:true,size:[60,40]}},profiles:{board:{from:'regions.keys'}},assemblies:{case:{preset:'enclosure',profile:'profiles.board',mounting:'bottom',board:{source:'asset',name:'board.kicad_pcb',components:{one:{size:['body*2','body*3'],height:['0','body']}}},height:24}}}}
    const result=await require('../helpers/adapter-engine').process(input,{analysis:true,assets:{'board.kicad_pcb':source.replace('Switch:SW_MX','Custom:Unknown').replace('"B.Cu"','"F.Cu"')}})
    const component=result.designs.analysis.case.parameters.components[0]
    const bounds=result.designs.features[component].bounds
    assert.equal(bounds.width,6)
    assert.equal(bounds.height,4)
})

it('keeps keycap clearance unresolved until measured envelopes are provided', async()=>{
    const input={points:{zones:{keys:{}}},designs:{regions:{keys:{where:true,size:20}},profiles:{board:{from:'regions.keys'}},assemblies:{case:{preset:'enclosure',profile:'profiles.board',mounting:'gasket',board:{source:'layout',family:'mx',name:'layout'},height:24}}}}
    const engine=require('../helpers/adapter-engine')
    const initial=await engine.process(input,{analysis:true})
    assert.ok(initial.designs.boards.case.findings.some(f=>f.code==='keycaps'&&f.severity==='warning'))
    input.designs.assemblies.case.board.keycaps={size:[18,18],height:[0,9]}
    const complete=await engine.process(input,{analysis:true})
    assert.ok(complete.designs.analysis.case.parameters.components.some(ref=>ref.endsWith('_keycap')))
    assert.ok(!complete.designs.boards.case.findings.some(f=>f.code==='keycaps'))
})

it('identifies a PCB-to-enclosure outline dependency cycle before CAD',async()=>{
    const input={points:{zones:{keys:{}}},pcbs:{board:{outlines:{edge:{outline:'case_plate',layer:'Edge.Cuts'}}}},designs:{regions:{keys:{where:true,size:20}},profiles:{board:{from:'regions.keys'}},assemblies:{case:{preset:'enclosure',profile:'profiles.board',mounting:'top',board:{source:'generated',name:'board'}}}}}
    await assert.rejects(require('../helpers/adapter-engine').process(input,{analysis:true}),error=>{
        assert.match(error.message,/Dependency cycle.*board.*case_plate.*case/)
        assert.equal(error.diagnostics[0].code,'dependency-cycle')
        return true
    })
})

it('allows unresolved component envelopes while keeping clearance visibly incomplete', async () => {
    const input={points:{zones:{keys:{}}},designs:{regions:{keys:{where:true}},profiles:{board:{from:'regions.keys'}},assemblies:{case:{preset:'enclosure',profile:'profiles.board',mounting:'bottom',board:{source:'asset',name:'board.kicad_pcb'},height:24,bezel:10}}}}
    const result=await require('../helpers/adapter-engine').process(input,{analysis:true,assets:{'board.kicad_pcb':source.replace('Switch:SW_MX','Custom:Unknown')}})
    const findings=result.designs.boards.case.findings.filter(f=>f.code==='component-height')
    assert.equal(findings.length,1)
    assert.equal(findings[0].severity,'warning')
    assert.match(findings[0].message,/not validated/)
})
