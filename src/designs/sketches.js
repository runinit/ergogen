const m = require('makerjs')
const a = require('../assert')
const anchor = require('../anchor').parse
const g = require('./geometry')
const solver = require('./solver')

const RADIANS = Math.PI / 180
const RESIDUAL = 0.00001

exports.parse = async (config, name, units, keys, options) => {
    a.unexpected(config, name, ['points', 'geometry', 'constraints', 'closed'])
    const primitives = [], ids = {}, original = {}, checks = [], adjustments = [], frames = {}
    let serial = 0
    const add = (id, primitive) => {
        if (ids[id]) { g.fail(name, `Duplicate sketch feature ${id}`) }
        ids[id] = String(++serial)
        primitives.push({id: ids[id], ...primitive})
        return ids[id]
    }
    const ref = (id, type) => {
        if (!ids[id] || (type && original[id]?.type !== type)) { g.fail(name, `Missing ${type || 'geometry'} reference ${id}`, 'reference') }
        return ids[id]
    }
    const num = (value, path) => g.number(value, `${name}.${path}`, units)
    for (const [id, point] of Object.entries(config.points || {})) {
        a.unexpected(point, `${name}.points.${id}`, ['at', 'anchor', 'fixed'])
        let at = point.at || [0, 0]
        if (point.anchor) {
            const origin = anchor(point.anchor, `${name}.points.${id}.anchor`, keys)(units)
            frames[id] = {angle: origin.r, handedness: origin.meta.mirrored ? -1 : 1}
            at = origin.shift(a.xy(at, name)(units)).p
        } else { at = a.xy(at, `${name}.points.${id}.at`)(units) }
        original[id] = {type: 'point', x: at[0], y: at[1], fixed: point.fixed === true}
        add(id, original[id])
    }
    for (const [id, geometry] of Object.entries(config.geometry || {})) {
        a.unexpected(geometry, `${name}.geometry.${id}`, ['type', 'points', 'center', 'radius', 'start', 'end', 'construction'])
        let primitive
        if (geometry.type === 'line' || geometry.type === 'bezier') {
            const count = geometry.type === 'line' ? 2 : 4
            if (geometry.points?.length !== count) { g.fail(name, `${id} requires ${count} named points`) }
            const points = geometry.points.map(point => ref(point, 'point'))
            primitive = geometry.type === 'line' ? {type: 'line', p1_id: points[0], p2_id: points[1]} : {
                type: 'bspline', pole_ids: points, weights: [1, 1, 1, 1], knots: [0, 1], mult: [4, 4], degree: 3, periodic: false
            }
        } else if (geometry.type === 'circle' || geometry.type === 'arc') {
            primitive = {type: geometry.type, c_id: ref(geometry.center, 'point'), radius: g.positive(geometry.radius, `${name}.geometry.${id}.radius`, units)}
            if (geometry.type === 'arc') {
                const start = original[geometry.start], end = original[geometry.end], center = original[geometry.center]
                primitive.start_id = ref(geometry.start, 'point')
                primitive.end_id = ref(geometry.end, 'point')
                primitive.start_angle = Math.atan2(start.y - center.y, start.x - center.x)
                primitive.end_angle = Math.atan2(end.y - center.y, end.x - center.x)
                if (primitive.end_angle <= primitive.start_angle) { primitive.end_angle += 2 * Math.PI }
            }
        } else { g.fail(name, `Unsupported geometry ${geometry.type}`) }
        original[id] = primitive
        const geometryId = add(id, primitive)
        if (geometry.type === 'arc') { primitives.push({id: String(++serial), type: 'arc_rules', a_id: geometryId}) }
    }
    const pointPair = spec => {
        if (spec.points?.length !== 2) { g.fail(name, 'Constraint requires two named points') }
        return {p1_id: ref(spec.points[0], 'point'), p2_id: ref(spec.points[1], 'point')}
    }
    for (const [id, spec] of Object.entries(config.constraints || {})) {
        const path = `${name}.constraints.${id}`
        let primitive, measure, target = 0, angle = false
        const line = key => original[key]
        const vec = (solved, key) => {
            const l = line(key), p = solved[l.p1_id], q = solved[l.p2_id]
            return [q.x - p.x, q.y - p.y]
        }
        const length = v => Math.hypot(...v)
        const cross = (v, w) => v[0] * w[1] - v[1] * w[0]
        const dot = (v, w) => v[0] * w[0] + v[1] * w[1]
        const pairMeasure = solved => {
            const p = solved[ref(spec.points[0])], q = solved[ref(spec.points[1])]
            return Math.hypot(p.x - q.x, p.y - q.y)
        }
        switch (spec.type) {
            case 'coincident':
            case 'distance':
                primitive = {type: spec.type === 'distance' ? 'p2p_distance' : 'p2p_coincident', ...pointPair(spec)}
                measure = pairMeasure
                break
            case 'horizontal':
            case 'vertical':
                primitive = {type: `${spec.type}_l`, l_id: ref(spec.line, 'line')}
                measure = solved => vec(solved, spec.line)[spec.type === 'horizontal' ? 1 : 0]
                break
            case 'parallel':
            case 'perpendicular':
            case 'equal_length':
            case 'angle': {
                const [first, second] = spec.lines || []
                primitive = {type: {parallel: 'parallel', perpendicular: 'perpendicular_ll', equal_length: 'equal_length', angle: 'l2l_angle_ll'}[spec.type], l1_id: ref(first, 'line'), l2_id: ref(second, 'line')}
                measure = solved => {
                    const v = vec(solved, first), w = vec(solved, second)
                    if (spec.type === 'equal_length') { return length(v) - length(w) }
                    if (spec.type === 'angle') { return Math.atan2(cross(v, w), dot(v, w)) / RADIANS }
                    return (spec.type === 'parallel' ? cross(v, w) : dot(v, w)) / Math.max(g.EPSILON, length(v) * length(w))
                }
                angle = spec.type === 'angle'
                break
            }
            case 'radius': {
                const kind = original[spec.geometry]?.type
                if (!['circle', 'arc'].includes(kind)) { g.fail(path, 'Radius requires a circle or arc') }
                primitive = {type: `${kind}_radius`, [kind === 'circle' ? 'c_id' : 'a_id']: ref(spec.geometry)}
                measure = solved => solved[ref(spec.geometry)].radius
                break
            }
            case 'equal_radius': {
                const [first, second] = spec.geometry || []
                const kinds = [first, second].map(id => original[id]?.type)
                if (!kinds.every(kind => ['circle', 'arc'].includes(kind))) { g.fail(path, 'Equal radius requires circles or arcs') }
                if (kinds[0] === 'arc' && kinds[1] === 'circle') { g.fail(path, 'List the circle before the arc') }
                primitive = {type: `equal_radius_${kinds.map(kind => kind[0]).join('')}`, [`${kinds[0][0]}1_id`]: ref(first), [`${kinds[1][0]}2_id`]: ref(second)}
                measure = solved => solved[ref(first)].radius - solved[ref(second)].radius
                break
            }
            case 'symmetric': {
                primitive = {type: 'p2p_symmetric_ppl', ...pointPair(spec), l_id: ref(spec.line, 'line')}
                measure = solved => {
                    const p = solved[ref(spec.points[0])], q = solved[ref(spec.points[1])]
                    const l = original[spec.line], origin = solved[l.p1_id], v = vec(solved, spec.line)
                    const mid = [(p.x + q.x) / 2 - origin.x, (p.y + q.y) / 2 - origin.y]
                    return Math.abs(cross(v, mid) / length(v)) + Math.abs(dot(v, [p.x - q.x, p.y - q.y]) / length(v))
                }
                break
            }
            case 'tangent': {
                if (spec.curves) {
                    let [first, second] = spec.curves
                    if (original[first]?.type === 'arc' && original[second]?.type === 'circle') { [first, second] = [second, first] }
                    const kinds = [first, second].map(id => original[id]?.type)
                    if (!kinds.every(kind => ['circle', 'arc'].includes(kind))) { g.fail(path, 'Curve-pair tangency requires circles or arcs') }
                    const mixed = kinds[0] !== kinds[1]
                    primitive = {type: `tangent_${kinds.map(kind => kind[0]).join('')}`,
                        [`${kinds[0][0]}${mixed ? '' : '1'}_id`]: ref(first),
                        [`${kinds[1][0]}${mixed ? '' : '2'}_id`]: ref(second)}
                    measure = solved => {
                        const left = solved[ref(first)], right = solved[ref(second)]
                        const p = solved[left.c_id], q = solved[right.c_id]
                        const distance = Math.hypot(q.x - p.x, q.y - p.y)
                        return Math.min(Math.abs(distance - left.radius - right.radius), Math.abs(distance - Math.abs(left.radius - right.radius)))
                    }
                    break
                }
                const kind = original[spec.curve]?.type
                if (kind === 'bspline') {
                    const endpoint = spec.at || 'start'
                    if (!['start', 'end'].includes(endpoint)) { g.fail(path, 'Bézier tangency uses at: start or end') }
                    // A cubic's endpoint tangent is exactly its adjacent control segment.
                    const poles = original[spec.curve].pole_ids
                    const pair = endpoint === 'start' ? poles.slice(0, 2) : poles.slice(2)
                    const tangentId = String(++serial), lineId = ref(spec.line, 'line')
                    primitives.push({id: tangentId, type: 'line', p1_id: pair[0], p2_id: pair[1]})
                    const pointId = endpoint === 'start' ? pair[0] : pair[1]
                    primitives.push({id: String(++serial), type: 'p2l_distance', p_id: pointId, l_id: lineId, distance: 0})
                    primitive = {type: 'parallel', l1_id: lineId, l2_id: tangentId}
                    measure = solved => {
                        const p = solved[pair[0]], q = solved[pair[1]], v = vec(solved, spec.line), w = [q.x - p.x, q.y - p.y]
                        const contact = solved[pointId], origin = solved[original[spec.line].p1_id]
                        return Math.abs(cross(v, w)) / Math.max(g.EPSILON, length(v) * length(w)) + Math.abs(cross(v, [contact.x - origin.x, contact.y - origin.y])) / length(v)
                    }
                    break
                }
                if (!['circle', 'arc'].includes(kind)) { g.fail(path, 'Tangency requires a line and circle or arc') }
                primitive = {type: `tangent_l${kind[0]}`, l_id: ref(spec.line, 'line'), [`${kind[0]}_id`]: ref(spec.curve)}
                measure = solved => {
                    const curve = solved[ref(spec.curve)], center = solved[curve.c_id]
                    const origin = solved[original[spec.line].p1_id], v = vec(solved, spec.line)
                    return Math.abs(cross(v, [center.x - origin.x, center.y - origin.y])) / length(v) - curve.radius
                }
                break
            }
            case 'fixed': {
                const point = original[spec.point]
                ref(spec.point, 'point')
                primitives.find(primitive => primitive.id === ids[spec.point]).fixed = true
                point.fixed = true
                continue
            }
            default: g.fail(path, `Unknown constraint ${spec.type}`)
        }
        let flexible
        if (['distance', 'radius', 'angle'].includes(spec.type)) {
            if (typeof spec.value === 'object') {
                flexible = Object.fromEntries(['target', 'min', 'max', 'priority'].map(key => [key, num(spec.value[key], `constraints.${id}.value.${key}`)]))
                if (flexible.min > flexible.target || flexible.max < flexible.target || flexible.priority <= 0) { g.fail(path, 'Invalid flexibility range or priority') }
                target = flexible.target
            } else { target = num(spec.value, `constraints.${id}.value`) }
            primitive[{distance: 'distance', radius: 'radius', angle: 'angle'}[spec.type]] = target * (angle ? RADIANS : 1)
        }
        primitive.id = String(++serial)
        if (flexible) { primitive.temporary = true; primitive.scale = flexible.priority }
        primitives.push(primitive)
        checks.push({id, spec, path, measure, target, flexible, angle})
    }
    const solvedList = await solver.solve(primitives, name, options)
    const solved = Object.fromEntries(solvedList.map(primitive => [primitive.id, primitive]))
    const dimensions = {}
    for (const {id, spec, path, measure, target, flexible, angle} of checks) {
        const actual = measure(solved)
        const error = angle ? Math.abs(((actual - target + 540) % 360) - 180) : Math.abs(actual - target)
        if (!Number.isFinite(actual) || (!flexible && error > RESIDUAL)) { g.fail(path, 'Fixed constraint residual exceeds tolerance', 'constraint') }
        if (['distance', 'radius', 'angle'].includes(spec.type)) { dimensions[id] = {...spec, actual} }
        if (!flexible) { continue }
        if (actual < flexible.min - RESIDUAL || actual > flexible.max + RESIDUAL) { g.fail(path, `Relaxed value ${actual} exceeds permitted range [${flexible.min}, ${flexible.max}]`, 'constraint') }
        adjustments.push({feature: path, target, actual, min: flexible.min, max: flexible.max, priority: flexible.priority})
    }
    const positions = {}
    for (const [id, point] of Object.entries(config.points || {})) {
        const value = solved[ids[id]], start = original[id]
        if (![value.x, value.y].every(Number.isFinite)) { g.fail(name, 'Nonfinite solver result') }
        if (start.fixed && Math.hypot(value.x - start.x, value.y - start.y) > RESIDUAL) { g.fail(name, `Fixed point ${id} moved`) }
        positions[id] = [value.x, value.y]
    }
    const model = {paths: {}, models: {}}, geometry = {points: positions, frames, dimensions, entities: {}}
    for (const [id, spec] of Object.entries(config.geometry || {})) {
        const value = solved[ids[id]]
        let shape
        if (spec.type === 'line') { shape = {paths: {edge: new m.paths.Line(...spec.points.map(id => positions[id]))}} }
        if (spec.type === 'bezier') { shape = g.bezier(spec.points.map(id => positions[id])) }
        if (spec.type === 'circle') { shape = {paths: {edge: new m.paths.Circle(positions[spec.center], value.radius)}} }
        if (spec.type === 'arc') { shape = {paths: {edge: new m.paths.Arc(positions[spec.center], value.radius, value.start_angle / RADIANS, value.end_angle / RADIANS)}} }
        geometry.entities[id] = {...spec, model: shape}
        if (!spec.construction) { model.models[id] = shape }
    }
    if (!g.empty(model)) { g.validate(model, name) }
    return {model, geometry, adjustments}
}
