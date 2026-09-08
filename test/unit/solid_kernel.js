const assert = require('node:assert/strict')
const m = require('makerjs')

describe('Solid kernel', function() {
    this.timeout(60000)

    it('exports a solid with an analytic round hole and releases its handles', async () => {
        const kernel = await require('../../src/designs/solid-kernel').open()
        const outer = m.model.center(new m.models.Rectangle(40, 30))
        const model = {models: {outer}, paths: {hole: new m.paths.Circle([0, 0], 3)}}
        try {
            const solid = kernel.extrude(model, 2)
            const result = await kernel.export(solid, 'plate')
            assert.ok(Math.abs(result.volume - (40 * 30 - Math.PI * 9) * 2) < 0.001)
            assert.match(result.step, /ISO-10303-21/)
            assert.match(result.step, /CYLINDRICAL_SURFACE/)
            assert.ok(result.stl.byteLength > 100)
            assert.ok(result.bounds.every(point => point.every(Number.isFinite)))
            const imported = await kernel.import(result.step)
            assert.ok(Math.abs(kernel.volume(imported) - result.volume) < 0.001)
        } finally {
            kernel.close()
        }
        assert.equal(kernel.retained(), 0)
    })
})

describe('Solid topology', function() {
    this.timeout(60000)
    it('rejects disconnected bodies as a manufactured part', async () => {
        const kernel = await require('../../src/designs/solid-kernel').open()
        try {
            const model = {models: {
                left: new m.models.Rectangle(10, 10),
                right: m.model.moveRelative(new m.models.Rectangle(10, 10), [20, 0])
            }}
            await assert.rejects(kernel.export(kernel.extrude(model, 2), 'detached'), /one connected solid/)
        } finally { kernel.close() }
    })
})

describe('KiCad model placement', function() {
    this.timeout(20000)
    it('matches the clockwise XYZ model rotations exported by KiCad 10', async () => {
        const assert=require('node:assert/strict'),m=require('makerjs')
        const kernel=await require('../../src/designs/solid-kernel').open()
        try {
            const cube=kernel.extrude(new m.models.Rectangle(1,2),3)
            const moved=kernel.placeModel(cube,{offset:[1,2,3],rotate:[20,30,40],scale:[1,1,1]},{side:'top',position:[30,-20],rotation:90},1.2)
            const expected=[[25.0881116386,-19.4202305344,3.6026037345],[28.5566703992,-16.8665378745,7.1363930440]]
            kernel.bounds(moved).forEach((point,i)=>point.forEach((value,j)=>assert.ok(Math.abs(value-expected[i][j])<0.01)))
        } finally {kernel.close()}
    })
})

it('reimports an STL as a closed STEP solid',async()=>{
    const assert=require('node:assert/strict'),m=require('makerjs')
    const kernel=await require('../../src/designs/solid-kernel').open()
    try {
        const part=await kernel.export(kernel.extrude(new m.models.Rectangle(4,4),4),'cube')
        const imported=await kernel.importMesh(part.stl)
        const result=await kernel.export(imported,'mesh')
        assert.ok(Math.abs(result.volume-64)<0.001)
    } finally {kernel.close()}
})

it('honours existing nonuniform model scales without changing the source asset',async()=>{
    const kernel=await require('../../src/designs/solid-kernel').open()
    try {
        const cube=kernel.extrude(new m.models.Rectangle(1,2),3)
        const scaled=kernel.placeModel(cube,{scale:[2,3,4]},{side:'top',rotation:0,position:[0,0]},0)
        kernel.validate(scaled)
        assert.ok(Math.abs(kernel.volume(scaled)-144)<0.001)
        assert.ok(Math.abs(kernel.volume(cube)-6)<0.001)
    } finally {kernel.close()}
})
