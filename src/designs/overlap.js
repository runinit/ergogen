const m = require('makerjs')
const g = require('./geometry')

// Scope cached bounds to one analysis: edits can replace or mutate models later.
module.exports = () => {
    const bounds = new WeakMap()
    const extent = model => {
        if (!bounds.has(model)) { bounds.set(model, m.measure.modelExtents(model)) }
        return bounds.get(model)
    }
    return (left, right) => {
        const a = extent(left), b = extent(right)
        if (!a || !b || a.high.some((value, axis) => value < b.low[axis] || b.high[axis] < a.low[axis])) { return false }
        return !g.empty(g.combine(left, right, 'intersect'))
    }
}
