const assert = require('node:assert/strict')
const m = require('makerjs')
const tooling = require('../../src/designs/tooling')
const manufacturing = require('../../src/designs/manufacturing')

describe('Enclosure manufacturing checks', () => {
    it('measures a sharp pocket independently of its declared settings', () => {
        assert.equal(tooling.radius(new m.models.Rectangle(20, 10)), 0)
        assert.ok(Math.abs(tooling.radius(new m.models.RoundRectangle(20, 10, 2)) - 2) < 0.001)
    })
    it('rejects malformed process envelopes instead of silently passing them', () => {
        const issues = manufacturing.check('bottom', {process: 'cnc', cutter: 3, reach: 30, setups: ['top'], stock: [-1, 20]},
            {wall: 3, depth: 10, width: 15, height: 15, holes: [], fillet: 2})
        assert.ok(issues.some(issue => issue.code === 'dimensions' && issue.severity === 'error'))
    })
})
