const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const {createRequire} = require('node:module')
const yaml = require('yaml')
const engine = require('../../src/ergogen')
const sexpr = require('../../src/templates/sexpr')
const children=(node,key)=>node.filter(value=>Array.isArray(value)&&value[0]===key)
const child=(node,key)=>children(node,key)[0] || []
const round=value=>Math.round(value*1e6)/1e6
const summarize = source => {
    const root=sexpr.parse(source)[0]
    const nets=new Map(children(root,'net').map(node=>[node[1],sexpr.value(node[2])]))
    const normalize=node=> {
        if (node[0]==='net') { return ['net',node[1]?.startsWith('"')?sexpr.value(node[1]):nets.get(node[1]) || ''] }
        if (node[0]==='stroke') { return normalize(child(node,'width')) }
        return node.map(value=>Array.isArray(value)?normalize(value):Number.isFinite(Number(value))?round(Number(value)):sexpr.value(value))
    }
    return [...children(root,'footprint'),...children(root,'module')].map(node=>({
        name:sexpr.value(node[1]), at:normalize(child(node,'at')), layer:normalize(child(node,'layer')),
        reference:sexpr.value(children(node,'fp_text').find(item=>item[1]==='reference')?.[2] || children(node,'property').find(item=>sexpr.value(item[1])==='Reference')?.[2] || '""'),
        pads:children(node,'pad').map(normalize)
    })).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

describe('Native BHK acceptance', function() {
    this.timeout(120000)
    it('preserves placement, footprints and pad nets while replacing the perimeter', async () => {
        for (const [name,source] of Object.entries(require('../fixtures/native-baseline/providers.json'))) {
            const module={exports:{}}
            vm.runInNewContext(source,{module,exports:module.exports,require:createRequire(path.resolve(__dirname,'../../src/footprints/virtual.js'))})
            engine.inject('footprint',name,module.exports)
        }
        const source=fs.readFileSync(path.resolve(__dirname,'../../docs/examples/native/bhk.yaml'),'utf8')
        const input=yaml.parse(source)
        const result=await engine.process(source,{analysis:true,debug:true})
        const original=require('../fixtures/native-baseline/bhk-points.json')
        for (const [id,point] of Object.entries(original)) {
            assert.equal(round(result.points[id].x),round(point.x),id)
            assert.equal(round(result.points[id].y),round(point.y),id)
            assert.equal(round(result.points[id].r),round(point.r),id)
        }
        const before=fs.readFileSync(path.resolve(__dirname,'../fixtures/native-baseline/bhk.kicad_pcb'),'utf8')
        assert.deepEqual(summarize(result.pcbs.bhk_pcb),summarize(before))
        assert.equal(Object.values(result.layout.objects).filter(item=>item.kind==='key').length,33)
        assert.equal(result.designs.features['profiles.bhk'].contours,1)
        assert.ok(result.layout.findings.some(item=>item.code==='component-height'))
        // Supplier dimensions preserve the electrical layout and unresolved MCU height.
        assert.deepEqual(result.layout.objects.display.envelopes.body.height,[0,2.9])
        assert.equal(round(result.layout.objects.display.position[2]),14.6)
        assert.equal(input.layout.objects.display.layer,'display_support')
        assert.equal(input.parts.controller.envelopes.body.height,undefined)
        const chains = require('../../src/designs/geometry').chains(result.designs.features['profiles.bhk'].model)
        assert.equal(chains.length,1)
        assert.equal(chains[0].contains?.length || 0,0,'No accidental interior Edge.Cuts slivers')
        for (const id of ['matrix_c7_r2','thumbfan_c2_r1','thumbfan_c3_r1']) {
            assert.deepEqual(result.layout.objects[id].envelopes.keycap.size,[18,27],id)
            assert.deepEqual(result.layout.objects[id].envelopes.plate.size,[14,14],id)
        }
        // The three marked transitions must contain material rather than inward notches.
        assert.equal(result.layout.objects.power_switch.kind,'component')
        assert.equal(result.layout.objects.reset_button.kind,'component')
        assert.deepEqual(result.layout.findings.filter(f=>f.code==='pcb-pad-outside'),[])
        const board = result.designs.features['profiles.bhk'].model
        const geometry = require('../../src/designs/geometry')
        const frames = require('../../src/native/frames')
        const maker = require('makerjs')
        // Exposed thumb edges retain their own angle instead of a convex-hull shortcut.
        for (const id of ['thumbfan_c1_r2','thumbfan_c2_r2','thumbfan_c3_r2']) {
            const key = result.layout.objects[id]
            const [width,height] = key.envelopes.pcb.size
            const clearance = input.designs.boundaries.board.clearance
            // The first edge may shorten where the two extended thumb directions meet.
            const samples=id==='thumbfan_c1_r2'?[-width/4,0]:[-width/4,0,width/4]
            for (const x of samples) {
                const edge = frames.transform(key.matrix,[x,-height/2-clearance,0]).slice(0,2)
                assert.ok(geometry.paths(board).some(segment => maker.measure.isPointOnPath(edge,segment,geometry.TOLERANCE)),`${id}: outline follows the bottom edge at ${x}`)
            }
        }
        // The red-marked thumb jogs become intersections of the retained edge directions.
        for (const point of [[220,-156.598444],[240,-162.412538]]) {
            assert.ok(geometry.paths(board).some(segment => segment.type==='line' && maker.measure.isPointOnPath(point,segment,geometry.TOLERANCE)),`Simplified thumb transition at ${point}`)
        }
        assert.ok(geometry.paths(board).filter(segment => segment.type==='arc' && Math.abs(segment.radius-3)<geometry.TOLERANCE).length>=6,'Inside corners have 3 mm fillets')
        const inside = require('makerjs').measure.isPointInsideModel
        for (const point of [[274,-65],[220,-151.5],[295,-133]]) {
            assert.ok(inside(point,board),`Straight transition at ${point}`)
        }
        assert.equal(input.pcbs.bhk_pcb.profile,'profiles.bhk')
        input.designs.boundaries.board.corners={chamfer:3}
        const chamfer=await engine.process(input,{analysis:true,debug:true})
        const exported=require('../../src/designs/board-inventory').read(chamfer.pcbs.bhk_pcb)
        assert.ok(geometry.paths(exported.model).every(segment=>segment.type==='line'),'Chamfered Edge.Cuts contain no arcs')
        for (const [left,right] of [[175,184],[195,203],[217,225],[236,245]]) {
            const step=geometry.paths(exported.model).filter(segment=>[segment.origin,segment.end].every(([x,y])=>x>left && x<right && y>-70))
            assert.equal(step.length,1,`One diagonal at the column step between ${left} and ${right}`)
            const [edge]=step
            assert.ok(Math.abs(Math.abs(edge.end[0]-edge.origin[0])-Math.abs(edge.end[1]-edge.origin[1]))<geometry.TOLERANCE)
        }
        assert.equal(geometry.chains(exported.model).length,1)
        assert.equal(geometry.chains(exported.model)[0].contains?.length || 0,0)
        assert.ok(exported.pads.every(pad=>!pad.approximate && geometry.contains(exported.model,pad.model)))
        assert.deepEqual(summarize(chamfer.pcbs.bhk_pcb),summarize(before))
    })
})
