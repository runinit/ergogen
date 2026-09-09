const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('yaml')
const engine = require('../../src/ergogen')

describe('Native solid placement', function() {
    this.timeout(120000)
    it('exports the same world-space body envelopes used for stacked clearance', async () => {
        const input=yaml.parse(fs.readFileSync(path.resolve(__dirname,'../../docs/examples/native/physical-stack.yaml'),'utf8'))
        input.designs.assemblies.keyboard.typing_angle=5
        const result=await engine.process(input,{debug:true})
        for (const id of ['mcu','screen','battery']) {
            const body=result.solids[`keyboard_components_native_${id}`]
            const expected=result.layout.objects[id].bounds.body
            assert.ok(body.volume>0)
            for (let side=0;side<2;side++) {
                for (let axis=0;axis<3;axis++) {
                    assert.ok(Math.abs(body.bounds[side][axis]-expected[side][axis])<0.01,`${id} boundary ${side}/${axis}`)
                }
            }
        }
        for (const part of ['bottom','top','plate']) { assert.ok(result.solids[`keyboard_${part}`].stl.length>0) }
    })
})
