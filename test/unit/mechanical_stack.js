const assert=require('node:assert/strict')
const engine=require('../../src/ergogen')
const fixture=()=>({schema:'ergogen/v1',units:{pcb_thickness:1.6},layout:{objects:{key:{kind:'key',pcb:'main',layer:'top',envelopes:{body:{size:[14,14],height:[0,11]},pcb:{size:[19,19]}}}},layers:{top:{surface:'pcb.main.top'}}},pcbs:{main:{profile:'profiles.board',thickness:'pcb_thickness'}},designs:{regions:{keys:{select:{kind:'key'},envelope:'pcb'}},profiles:{board:{from:'regions.keys',clearance:2}},stackups:{main:{pcb:'main',plate:{thickness:1.5,gap:5},layers:{foam:{material:'foam',lower:'pcb.top',upper:'plate.bottom',thickness:3}}}}}})
describe('Mechanical sheet layers',function(){
    this.timeout(30000)
    it('exports an independent millimetre outline with a switch cutout',async()=>{
        const result=await engine.process(fixture(),{svg:true})
        assert.equal(result.stackups.main.layers.foam.remaining,2)
        assert.equal(result.stackups.main.layers.foam.status,'ready')
        assert.ok(result.outlines.main_foam.dxf.includes('SECTION'))
        assert.equal(result.stackups.main.layers.foam.holes,1)
        assert.equal(result.solids.material_main_foam.reference,true)
        assert.ok(result.solids.material_main_foam.volume>0)
    })
    it('fits compressed sheets in order within their shared gap',async()=>{
        const config=fixture()
        config.designs.stackups.main.layers.foam.compression=0.2
        config.designs.stackups.main.layers.silicone={material:'silicone',lower:'pcb.top',upper:'plate.bottom',thickness:3}
        const result=await engine.process(config,{analysis:true})
        assert.ok(Math.abs(result.stackups.main.layers.foam.installed-2.4)<1e-6)
        assert.ok(Math.abs(result.stackups.main.layers.silicone.z-4)<1e-6)
        assert.equal(result.stackups.main.layers.silicone.status,'interference')
    })
    it('keeps missing material surfaces local to that layer',async()=>{
        const config=fixture();config.designs.stackups.main.layers.foam.upper='battery.body.bottom'
        const result=await engine.process(config,{analysis:true})
        assert.equal(result.stackups.main.layers.foam.status,'unresolved')
        assert.ok(result.pcbs.main)
    })
    it('reports interference without moving the stack or blocking other outputs',async()=>{
        const config=fixture();config.designs.stackups.main.layers.foam.thickness=6
        const result=await engine.process(config,{svg:true})
        assert.equal(result.stackups.main.layers.foam.status,'interference')
        assert.equal(result.stackups.main.layers.foam.remaining,-1)
        assert.equal(result.outlines.main_foam,undefined)
        assert.ok(result.pcbs.main)
    })
})
