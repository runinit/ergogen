const engine = require('../../src/ergogen')
const sketch = () => ({points: {
    origin: {at: [0, 0], fixed: true}, end: {at: [12, 3]}
}, geometry: {edge: {type: 'line', points: ['origin', 'end'], construction: true}}, constraints: {
    level: {type: 'horizontal', line: 'edge'}, length: {type: 'distance', points: ['origin', 'end'], value: 20}
}})
const run = value => engine.process({points: {zones: {key: {}}}, designs: {sketches: {test: value}}}, {debug: true})

describe('Design sketch solver', function() {
    this.timeout(30000)
    it('solves fixed dimensions and produces repeatable results', async () => {
        const first = await run(sketch()), second = await run(sketch())
        const end = first.designs.features['sketches.test'].sketch.points.end
        expect(end[0]).to.be.closeTo(20, 0.00001)
        expect(end[1]).to.be.closeTo(0, 0.00001)
        expect(first.designs).to.deep.equal(second.designs)
    })
    it('rejects impossible fixed constraints and missing named points', async () => {
        const input = sketch()
        input.points.end.fixed = true
        await expect(run(input)).to.be.rejectedWith('constraints')
        delete input.points.end
        await expect(run(input)).to.be.rejectedWith('end')
    })
    it('reports flexible adjustments and rejects out-of-range relaxation', async () => {
        const input = sketch()
        input.points.end = {at: [12, 0], fixed: true}
        input.constraints.length.value = {target: 15, min: 10, max: 20, priority: 1}
        const result = await run(input)
        expect(result.designs.adjustments[0].actual).to.be.closeTo(12, 0.00001)
        input.constraints.length.value.min = 14
        await expect(run(input)).to.be.rejectedWith('range')
    })
    it('constrains a cubic tangent at a named endpoint', async () => {
        const input = {points: {
            a: {at: [-10, 0], fixed: true}, b: {at: [10, 0], fixed: true},
            start: {at: [0, 0], fixed: true}, control: {at: [3, 2]},
            other: {at: [7, 8]}, end: {at: [10, 10], fixed: true}
        }, geometry: {
            axis: {type: 'line', points: ['a', 'b'], construction: true},
            curve: {type: 'bezier', points: ['start', 'control', 'other', 'end'], construction: true}
        }, constraints: {smooth: {type: 'tangent', line: 'axis', curve: 'curve', at: 'start'}}}
        const result = await run(input)
        expect(result.designs.features['sketches.test'].sketch.points.control[1]).to.be.closeTo(0, 0.00001)
    })
    it('solves tangency between circles and exposes measured dimensions', async () => {
        const input = {points: {a: {at: [0, 0], fixed: true}, b: {at: [9, 0]}}, geometry: {
            first: {type: 'circle', center: 'a', radius: 3, construction: true},
            second: {type: 'circle', center: 'b', radius: 2, construction: true}
        }, constraints: {
            first_radius: {type: 'radius', geometry: 'first', value: 3},
            second_radius: {type: 'radius', geometry: 'second', value: 2},
            touch: {type: 'tangent', curves: ['first', 'second']}
        }}
        const result = await run(input), geometry = result.designs.features['sketches.test'].sketch
        expect(Math.hypot(...geometry.points.b)).to.be.closeTo(5, 0.00001)
        expect(geometry.dimensions.first_radius.actual).to.be.closeTo(3, 0.00001)
    })
    it('exports a closed cubic Bézier sketch with bounded chord error', async () => {
        const input = {points: {a: {at: [0, 0]}, b: {at: [0, 10]}, c: {at: [10, 10]}, d: {at: [10, 0]}}, geometry: {
            curve: {type: 'bezier', points: ['a', 'b', 'c', 'd']}, base: {type: 'line', points: ['d', 'a']}
        }}
        const result = await run(input)
        expect(result.designs.features['sketches.test'].contours).to.equal(1)
        expect(result.designs.tolerance).to.equal(0.01)
    })
})

for (const type of ['parallel', 'perpendicular', 'equal_length', 'angle']) {
    it(`solves ${type} between named lines`, async () => {
        const input = {points: {a: {at: [0, 0], fixed: true}, b: {at: [10, 0], fixed: true}, c: {at: [0, 5], fixed: true}, d: {at: [8, 9]}}, geometry: {
            first: {type: 'line', points: ['a', 'b'], construction: true}, second: {type: 'line', points: ['c', 'd'], construction: true}
        }, constraints: {rule: {type, lines: ['first', 'second'], ...(type === 'angle' ? {value: 45} : {})}}}
        const result = await run(input)
        expect(result.designs.features['sketches.test'].sketch.points.d.every(Number.isFinite)).to.equal(true)
    })
}
it('solves symmetry and equal radii with named references', async () => {
    const input = {points: {
        a: {at: [0, -10], fixed: true}, b: {at: [0, 10], fixed: true}, p: {at: [-5, 0], fixed: true}, q: {at: [6, 2]}
    }, geometry: {axis: {type: 'line', points: ['a', 'b'], construction: true},
        left: {type: 'circle', center: 'p', radius: 2, construction: true}, right: {type: 'circle', center: 'q', radius: 3, construction: true}
    }, constraints: {mirror: {type: 'symmetric', points: ['p', 'q'], line: 'axis'}, equal: {type: 'equal_radius', geometry: ['left', 'right']}}}
    const result = await run(input), q = result.designs.features['sketches.test'].sketch.points.q
    expect(q[0]).to.be.closeTo(5, 0.00001)
    expect(q[1]).to.be.closeTo(0, 0.00001)
})
