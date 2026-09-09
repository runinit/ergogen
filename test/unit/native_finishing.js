const assert = require('node:assert/strict')
const m = require('makerjs')
const engine = require('../../src/ergogen')
const g = require('../../src/designs/geometry')

const stock = [[0,0],[40,0],[40,20],[20,20],[20,40],[0,40]]
const stepStock = [[0,0],[60,0],[60,30],[30,30],[30,32.375],[0,32.375]]
const fixture = corners => ({
    schema: 'ergogen/v1', layout: {},
    designs: {
        regions: {stock: {shape: {polygon: stock}}},
        profiles: {board: {from: 'regions.stock', corners}}
    }
})
const generate = async input => (await engine.process(input,{debug:true,analysis:true})).designs.features['profiles.board'].model

describe('Native perimeter finishing', () => {
    it('adds a tangent inside fillet without removing support', async () => {
        const board = await generate(fixture({fillet:3}))
        assert.ok(g.contains(board,new m.models.ConnectTheDots(true,stock)))
        assert.ok(g.paths(board).some(p => p.type==='arc' && Math.abs(p.radius-3)<g.TOLERANCE && m.measure.pointDistance(p.origin,[23,23])<g.TOLERANCE))
        g.validate(board,'board','single')
    })

    it('offers straight chamfers across the inside relief tangent points', async () => {
        const board = await generate(fixture({chamfer:3}))
        assert.ok(g.contains(board,new m.models.ConnectTheDots(true,stock)))
        assert.ok(g.paths(board).some(p => p.type==='line' && [[20,23],[23,20]].every(point => m.measure.isPointOnPath(point,p,g.TOLERANCE))))
        assert.equal(g.paths(board).filter(p => p.type==='arc').length,0)
    })

    it('chamfers outside clearance arcs too without cutting required clearance', async () => {
        const input = fixture({chamfer:3})
        input.designs.profiles.board.clearance = 2
        const board = await generate(input)
        assert.ok(g.paths(board).every(path=>path.type==='line'),'Chamfer mode leaves no fillets')
        assert.ok(g.contains(board,g.offset(new m.models.ConnectTheDots(true,stock),2)))
        g.validate(board,'board','single')
    })

    it('uses one diagonal across a shallow chamfered step', async () => {
        const input = fixture({chamfer:3})
        const polygon = stepStock
        input.designs.regions.stock.shape.polygon = polygon
        input.designs.profiles.board.clearance = 2
        const board = await generate(input)
        const transition = g.paths(board).filter(p=>p.type==='line' && [p.origin,p.end].every(([x,y])=>x>20 && x<40 && y>=32-g.TOLERANCE))
        assert.equal(transition.length,1,'No short facets between the horizontal edges')
        const edge=transition[0]
        assert.ok(Math.abs(Math.abs(edge.end[0]-edge.origin[0])-Math.abs(edge.end[1]-edge.origin[1]))<g.TOLERANCE,'A single 45 degree chamfer')
        assert.ok(g.contains(board,g.offset(new m.models.ConnectTheDots(true,polygon),2)))
    })

    it('keeps the same clean step when rotated and traversed in reverse', async () => {
        const input = fixture({chamfer:3})
        input.designs.regions.stock.shape.polygon = stepStock
        input.designs.profiles.board.clearance = 2
        const expected=m.model.rotate(await generate(input),90,[0,0])
        input.designs.regions.stock.shape.polygon = stepStock.map(([x,y])=>[-y,x]).reverse()
        const rotated=await generate(input)
        assert.ok(g.contains(rotated,expected) && g.contains(expected,rotated))
        assert.equal(g.paths(rotated).length,g.paths(expected).length)
    })

    it('simplifies a short jog by intersecting its neighboring straight edges', async () => {
        const input = fixture(undefined)
        const polygon = [[0,0],[20,0],[20,20],[11,20],[10,21],[0,25]]
        input.designs.regions.stock.shape.polygon = polygon
        input.designs.profiles.board.simplify = 5
        const board = await generate(input)
        assert.ok(g.contains(board,new m.models.ConnectTheDots(true,polygon)))
        assert.ok(g.paths(board).some(p => p.type==='line' && m.measure.isPointOnPath([12.5,20],p,g.TOLERANCE)))
        assert.equal(g.paths(board).length,5)
    })

    it('rejects conflicting styles and invalid dimensions at their source', async () => {
        for (const corners of [{fillet:3,chamfer:2},{fillet:-1},{chamfer:0},{fillet:100}]) {
            await assert.rejects(generate(fixture(corners)),/corners/)
        }
        const input = fixture(undefined)
        input.designs.profiles.board.simplify = -1
        await assert.rejects(generate(input),/simplify/)
    })

    it('retains explicit cutouts after corner finishing', async () => {
        const input = fixture({fillet:3})
        input.designs.regions.hole = {shape:{radius:2,anchor:{shift:[10,10]}}}
        input.designs.profiles.board.cutouts = ['regions.hole']
        const board = await generate(input)
        assert.equal(g.chains(board)[0].contains.length,1)
        assert.ok(g.paths(board).some(p => p.type==='circle' && p.radius===2))
    })

    it('respects the simplification limit and preserves already tangent outside arcs', async () => {
        const input = fixture(undefined)
        input.designs.regions.stock.shape.polygon = [[0,0],[20,0],[20,20],[11,20],[10,21],[0,25]]
        input.designs.profiles.board.simplify = 1
        assert.equal(g.paths(await generate(input)).length,6)
        input.designs.regions.stock.shape = {size:[40,30],corner_radius:2}
        input.designs.profiles.board.simplify = 8
        const rounded = await generate(input)
        assert.equal(g.paths(rounded).filter(p => p.type==='arc' && p.radius===2).length,4)
    })

    it('follows winding and unit expressions without rounding outside corners', async () => {
        const input = fixture({fillet:'tool_radius'})
        input.units = {tool_radius:3}
        input.designs.regions.stock.shape.polygon = [...stock].reverse().map(([x,y])=>[-x,y])
        const board = await generate(input)
        assert.equal(g.paths(board).filter(p=>p.type==='arc').length,1)
        assert.ok(g.paths(board).some(p => p.type==='arc' && m.measure.pointDistance(p.origin,[-23,23])<g.TOLERANCE))
    })
})
