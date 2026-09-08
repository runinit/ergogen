const m = require('makerjs')
const g = require('./geometry')
const TANGENT_SAMPLE = 0.00001
const TANGENT_TOLERANCE = 0.0001

// Inspect the actual pocket boundary; a declared radius alone proves nothing.
exports.radius = model => {
    let radius = Infinity
    for (const chain of g.chains(model)) {
        const edges = chain.links.map(link => {
            const path = m.path.moveRelative(m.path.clone(link.walkedPath.pathContext), link.walkedPath.offset)
            if (path.radius) { radius = Math.min(radius, path.radius) }
            if (path.type === 'circle') { return null }
            const sample = t => m.point.middle(path, link.reversed ? 1 - t : t)
            const unit = (a, b) => {
                const length = m.measure.pointDistance(a, b)
                return b.map((v, i) => (v - a[i]) / length)
            }
            return {start: unit(sample(0), sample(TANGENT_SAMPLE)), end: unit(sample(1 - TANGENT_SAMPLE), sample(1))}
        })
        for (let index = 0; index < edges.length; index++) {
            const edge = edges[index], next = edges[(index + 1) % edges.length]
            if (!edge || !next) { continue }
            if (edge.end.some((v, axis) => Math.abs(v - next.start[axis]) > TANGENT_TOLERANCE)) { return 0 }
        }
    }
    return radius
}
