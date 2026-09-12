const assert = require('node:assert/strict')
const engine = require('../../src/ergogen')
const layout = require('../../src/native/layout')
const fixture = () => ({schema:'ergogen/v1', units:{u:19}, layout:{
    clusters:{fingers:{arrangement:{type:'columns', columns:['c1'], rows:['r1','r2'], pitch:['u','u'], splay:{c1:30}}}},
    objects:{a:{kind:'key',cluster:'fingers',cell:['c1','r1'],envelopes:{keycap:{size:[18,18]}}},
        b:{kind:'key',cluster:'fingers',cell:['c1','r2'],envelopes:{keycap:{size:[18,18]}}},
        encoder:{kind:'component',placement:{at:[30,40,0],solve:['x','y']},envelopes:{body:{size:[12,12],at:[2,0,0]}}}},}})
describe('Layout center guides', function () {
    this.timeout(30000)
    it('resolves physical centers and splayed column frames', () => {
        const scene = layout.resolve(fixture())
        assert.equal(scene.reference('encoder.center').position[0],32)
        const column = scene.reference('columns.fingers.c1')
        assert.ok(Math.abs(column.matrix[4]-0.5)<1e-6)
        assert.equal(column.guideParent,'clusters.fingers')
    })
    it('aligns a component to a rotated column without rotating the component', async () => {
        const config=fixture()
        config.layout.constraints={center:{type:'aligned',refs:['encoder.center','columns.fingers.c1'],axis:'y'}}
        const result=await engine.process(config,{layoutOnly:true})
        const scene=layout.resolve(config)
        const target=scene.reference('columns.fingers.c1')
        const pos=result.layout.objects.encoder.position
        const dx=pos[0]+2-target.position[0],dy=pos[1]-target.position[1]
        assert.ok(Math.abs(dx*target.matrix[0]+dy*target.matrix[4])<1e-5)
        assert.ok(Math.abs(result.layout.objects.encoder.rotation)<1e-5)
    })
})
