const m = require('makerjs')
const a = require('../assert')
const g = require('./geometry')

const DEFAULT_HOLE = 1.2
const DEFAULT_POST_HEIGHT = 5
const DEGREES = 180 / Math.PI
const TANGENT_STEP = 0.0001
const overlap = require('./overlap')

// Suggestions remain declarations; callers explicitly accept their stable anchors.
exports.suggest = (spec, context) => {
    const {base, exterior, units, name, shape, mounts, exclusions, components, gasketModels, height} = context
    const intersects = overlap()
    const settings = spec.suggest
    if (!settings) { return [] }
    a.unexpected(settings, `${name}.suggest`, ['spacing', 'inset', 'post', 'hole', 'height', 'gaskets'])
    const suggestions = [], center = m.measure.modelExtents(base).center
    const forbidden = [...exclusions, ...components.map(component => component.model)]
    const anchor = (position, rotate = 0) => ({feature: spec.profile, shift: position.map((value, axis) => value - center[axis]), rotate})
    const circle = (position, radius) => ({paths: {circle: new m.paths.Circle(position, radius)}})
    const clear = model => g.contains(exterior, model) && !forbidden.some(other => intersects(model, other))
    if (settings.spacing !== undefined) {
        const dim = (key, fallback) => g.positive(settings[key] ?? fallback, `${name}.suggest.${key}`, units)
        const spacing = dim('spacing'), inset = dim('inset'), post = dim('post')
        const hole = dim('hole', DEFAULT_HOLE), postHeight = dim('height', Math.min(DEFAULT_POST_HEIGHT, height))
        if (hole >= post || postHeight > height) { g.fail(`${name}.suggest`, 'Suggested holes and posts must fit') }
        let serial = 0
        for (const chain of g.chains(g.offset(base, -inset))) {
            for (const position of m.chain.toPoints(chain, spacing)) {
                const id = `mount_${++serial}`, envelope = circle(position, post)
                if (mounts[id] || !clear(envelope)) { continue }
                if (Object.values(mounts).some(mount => m.measure.pointDistance(mount.position, position) < post + mount.post)) { continue }
                if (suggestions.some(suggestion => m.measure.pointDistance(suggestion.position, position) < spacing / 2)) { continue }
                const definition = {anchor: anchor(position), hole, post, height: postHeight}
                suggestions.push({id, kind: 'mount', position, ...definition, definition})
            }
        }
    }
    if (!settings.gaskets) { return suggestions }
    const gasket = settings.gaskets, path = `${name}.suggest.gaskets`
    a.unexpected(gasket, path, ['spacing', 'size'])
    const spacing = g.positive(gasket.spacing, `${path}.spacing`, units)
    const size = a.wh(gasket.size, `${path}.size`)(units)
    size.forEach(value => g.positive(value, `${path}.size`))
    const occupied = [...gasketModels, ...Object.values(mounts).map(mount => circle(mount.position, mount.post))]
    let serial = 0
    for (const edge of g.paths(base)) {
        const length = m.measure.pathLength(edge)
        if (length < size[0]) { continue }
        const count = Math.max(1, Math.floor(length / Math.max(spacing, size[0])))
        for (let index = 0; index < count; index++) {
            const id = `gasket_${++serial}`, t = (index + 0.5) / count
            if (spec.gaskets?.[id]) { continue }
            const position = m.point.middle(edge, t)
            const from = m.point.middle(edge, t - TANGENT_STEP), to = m.point.middle(edge, t + TANGENT_STEP)
            const rotate = Math.atan2(to[1] - from[1], to[0] - from[0]) * DEGREES
            const definition = {anchor: anchor(position, rotate), size}
            const envelope = shape(definition, path)
            if (!clear(envelope) || !intersects(envelope, base) || occupied.some(other => intersects(envelope, other))) { continue }
            occupied.push(envelope)
            suggestions.push({id, kind: 'gasket', position, definition})
        }
    }
    return suggestions
}
