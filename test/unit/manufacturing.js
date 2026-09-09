const assert = require('node:assert/strict')
const m = require('makerjs')
const g = require('../../src/designs/geometry')
const tooling = require('../../src/designs/tooling')
const manufacturing = require('../../src/designs/manufacturing')

describe('Enclosure manufacturing checks', () => {
    it('measures a sharp pocket independently of its declared settings', () => {
        assert.equal(tooling.radius(new m.models.Rectangle(20, 10)), 0)
        assert.ok(Math.abs(tooling.radius(new m.models.RoundRectangle(20, 10, 2)) - 2) < 0.001)
    })
    it('relieves sharp CNC pockets without shrinking their required opening', () => {
        const source = new m.models.Rectangle(20, 10)
        const before = JSON.stringify(source)
        const pocket = tooling.prepare(source, {process: 'cnc', cutter: 3})
        g.validate(pocket, 'pocket', 'single')
        assert.ok(g.contains(pocket, source))
        assert.ok(tooling.radius(pocket) >= 1.5 - g.TOLERANCE)
        assert.equal(JSON.stringify(source), before)
        assert.equal(JSON.stringify(tooling.prepare(source, {process: 'fdm'})), before)
    })
    it('measures relieved rotated corners independently of chain start and winding', () => {
        for (const angle of [-30, 0, 25, 90, 180]) {
            const source = m.model.rotate(new m.models.Rectangle(14, 14), angle)
            const pocket = tooling.prepare(source, {process: 'cnc', cutter: 1})
            assert.ok(tooling.radius(pocket) >= 0.5 - g.TOLERANCE, `rotation ${angle}`)
            assert.equal(g.paths(pocket).length, 8, 'One relief arc per corner')
        }
    })
    it('adapts small fillets and rotated openings to the actual cutter', () => {
        const source = m.model.rotate(new m.models.RoundRectangle(20, 10, 0.4), 25)
        const pocket = tooling.prepare(source, {process: 'cnc', cutter: 4})
        g.validate(pocket, 'pocket', 'single')
        assert.ok(g.contains(pocket, source))
        assert.ok(tooling.radius(pocket) >= 2 - g.TOLERANCE)
    })
    it('protects mounting contacts beside a CNC plate cutout', () => {
        const pockets = [{part:'plate', id:'switch', model:new m.models.Rectangle(14,14), z:0, height:1.5}]
        const spec = {plate:1.5, wall:3, manufacturing:{plate:{process:'cnc', cutter:3, min_wall:0.8}}}
        const bounds = {plate:m.model.center(new m.models.Rectangle(100,100)),
            posts:[{id:'mounts.tab', z:0, height:1.5, model:{paths:{post:new m.paths.Circle([14.4,1],0.2)}}}]}
        const [plan] = require('../../src/designs/pocket-plan').prepare(pockets,spec,bounds,'case')
        assert.equal(plan.adjusted,false)
        assert.match(plan.failure,/mounting post/)
    })
    it('checks posts only where their height overlaps cutter relief', () => {
        const pockets = [{part: 'top', id: 'opening', model: new m.models.Rectangle(20,20), z: 20, height: 3}]
        const spec = {wall: 1, manufacturing: {top: {process: 'cnc', cutter: 3, min_wall: 1}}}
        for (const [z, height, blocked] of [[0,1,false], [19,1,false], [23,1,false], [24,1,false], [20,1,true]]) {
            const bounds = {shell: m.model.moveRelative(new m.models.Rectangle(40,40), [-10,-10]),
                posts: [{id: 'mounts.post', model: m.model.moveRelative(new m.models.Rectangle(1,1), [-1,-1]), z, height}]}
            const [plan] = require('../../src/designs/pocket-plan').prepare(pockets, spec, bounds, 'case')
            assert.equal(Boolean(plan.failure), blocked, `post at ${z}`)
        }
    })
    it('retains material around a nut pocket inside its own post', () => {
        const pockets = [{part:'bottom', id:'mounts.nut', model:new m.models.Polygon(6,1.2), z:0, height:2}]
        const spec = {plate:1.5, wall:3, manufacturing:{bottom:{process:'cnc', cutter:3, min_wall:1}}}
        const bounds = {shell:m.model.center(new m.models.Rectangle(100,100)),
            posts:[{id:'mounts.nut', min_wall:0.2, model:{paths:{post:new m.paths.Circle([0,0],1.5)}}}]}
        const [plan] = require('../../src/designs/pocket-plan').prepare(pockets,spec,bounds,'case')
        assert.equal(plan.adjusted,false)
        assert.match(plan.failure,/post wall/)
    })
    it('rejects malformed process envelopes instead of silently passing them', () => {
        const issues = manufacturing.check('bottom', {process: 'cnc', cutter: 3, reach: 30, setups: ['top'], stock: [-1, 20]},
            {wall: 3, depth: 10, width: 15, height: 15, holes: [], fillet: 2})
        assert.ok(issues.some(issue => issue.code === 'dimensions' && issue.severity === 'error'))
    })
})
