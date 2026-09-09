const m = require('makerjs')
const g = require('./geometry')
const MAX_RELIEF_PASSES = 3
const TANGENT_SAMPLE = 0.00001
const TANGENT_TOLERANCE = 0.0001

const edges = chain => chain.links.map(link => {
    const path = m.path.moveRelative(m.path.clone(link.walkedPath.pathContext), link.walkedPath.offset)
    if (path.type === 'circle') { return {path, reversed: link.reversed} }
    const sample = t => m.point.middle(path, link.reversed ? 1 - t : t)
    const unit = (a, b) => {
        const length = m.measure.pointDistance(a, b)
        return b.map((value, index) => (value - a[index]) / length)
    }
    return {path, reversed: link.reversed, corner: sample(1), scale: path.radius || m.measure.pathLength(path),
        start: unit(sample(0), sample(TANGENT_SAMPLE)), end: unit(sample(1 - TANGENT_SAMPLE), sample(1))}
})

// Signed line/arc area remains stable for relief arcs spanning over 180 degrees.
const clockwise = chain => edges(chain).reduce((area, {path, reversed}) => {
    if (path.type === 'circle') { return area + Math.PI * path.radius ** 2 * 2 }
    const [start, end] = m.point.fromPathEnds(path)
    const span = ((path.endAngle - path.startAngle) % 360 + 360) % 360 * Math.PI / 180
    const integral = path.type === 'arc'
        ? path.origin[0] * (end[1] - start[1]) - path.origin[1] * (end[0] - start[0]) + path.radius ** 2 * span
        : start[0] * end[1] - start[1] * end[0]
    return area + (reversed ? -integral : integral)
}, 0) < 0

const convex = (edge, next, clockwise) => {
    if (!edge.end || !next.start) { return false }
    const turn = (edge.end[0] * next.start[1] - edge.end[1] * next.start[0]) * (clockwise ? -1 : 1)
    return turn > TANGENT_TOLERANCE && turn * Math.min(edge.scale, next.scale) > g.TOLERANCE
}

// Inspect the actual pocket boundary; a declared radius alone proves nothing.
exports.radius = model => {
    let radius = Infinity
    for (const chain of g.chains(model)) {
        const winding = clockwise(chain)
        const boundary = edges(chain)
        for (const [index, edge] of boundary.entries()) {
            const {path, reversed} = edge
            // Reentrant pocket turns leave convex material; they do not limit the tool.
            if (path.radius && (path.type === 'circle' || Boolean(reversed) === winding)) {
                radius = Math.min(radius, path.radius)
            }
            if (convex(edge, boundary[(index + 1) % boundary.length], winding)) { return 0 }
        }
    }
    return radius
}

// Add local cutter relief instead of rounding material into a required opening.
const relieve = (model, radius) => {
    const reliefs = []
    const circle = center => reliefs.push({paths: {tool: new m.paths.Circle(center, radius)}})
    for (const chain of g.chains(model)) {
        const winding = clockwise(chain)
        const boundary = edges(chain)
        for (const [index, edge] of boundary.entries()) {
            const {path, reversed} = edge
            // Circular bores retain their specified fit and are checked against the drill.
            if (path.type === 'circle') { continue }
            if (path.radius < radius && Boolean(reversed) === winding) { circle(path.origin) }
            const next = boundary[(index + 1) % boundary.length]
            if (!convex(edge, next, winding)) { continue }
            const bisector = next.start.map((value, axis) => value - edge.end[axis])
            const length = Math.hypot(...bisector)
            circle(edge.corner.map((value, axis) => value + bisector[axis] / length * (radius - g.TOLERANCE)))
        }
    }
    return reliefs.reduce((result, relief) => g.combine(result, relief), g.clone(model))
}

exports.prepare = (model, spec = {}) => {
    const radius = spec.process === 'cnc' ? spec.cutter / 2 : 0
    let result = g.clone(model)
    // Neighboring steps can expose another short corner after a relief merges.
    for (let pass = 0; radius > 0 && pass < MAX_RELIEF_PASSES; pass++) {
        if (exports.radius(result) >= radius - g.TOLERANCE) { break }
        result = relieve(result, radius)
    }
    return result
}
