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
