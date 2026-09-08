const m = require('makerjs')
const u = require('../utils')
const a = require('../assert')

const TOLERANCE = 0.01 // Millimetres; also the maximum Bézier chord error.
const EPSILON = 0.000001
const MAX_OFFSET_STEPS = 1000
const REPAIR_OFFSET_STEP = TOLERANCE * 10
const Joint = {Round: 0, Pointed: 1}

class DesignError extends Error {
    constructor(feature, message, code = 'geometry') {
        super(`${feature}: ${message}`)
        this.name = 'DesignError'
        this.diagnostics = [{feature, message, code, severity: 'error'}]
    }
}

const fail = (feature, message, code) => { throw new DesignError(feature, message, code) }
const number = (value, name, units = {}) => {
    let result
    try {
        result = a.sane(value, name, 'number')(units)
    } catch (error) {
        fail(name, error.message, 'dimension')
    }
    if (!Number.isFinite(result)) {
        fail(name, 'Expected a finite dimension', 'dimension')
    }
    return result
}
const positive = (value, name, units) => {
    const result = number(value, name, units)
    if (result <= 0) {
        fail(name, 'Expected a positive dimension', 'dimension')
    }
    return result
}
const clone = u.deepcopy
const paths = model => {
    const result = []
    m.model.walk(model, {onPath: entry => {
        result.push(m.path.moveRelative(m.path.clone(entry.pathContext), entry.offset))
    }})
    return result
}
const empty = model => !paths(model).length
const combine = (left, right, operation = 'add') => {
    if (!['add', 'subtract', 'intersect'].includes(operation)) {
        fail('designs', `Unknown operation ${operation}`)
    }
    if (empty(left)) {
        return operation === 'add' ? clone(right) : {paths: {}}
    }
    if (empty(right)) {
        return operation === 'intersect' ? {paths: {}} : clone(left)
    }
    return u[operation](clone(left), clone(right))
}
const union = models => models.reduce((result, model) => combine(result, model), {paths: {}})
const offset = (model, distance, joints = Joint.Round) => {
    if (Math.abs(distance) < EPSILON) {
        return clone(model)
    }
    const direct = m.model.outline(clone(model), Math.abs(distance), joints, distance < 0, {farPoint: u.farPoint})
    if (distance < 0) { return direct }
    const bounds = m.measure.modelExtents(model)
    const valid = result => {
        const expanded = m.measure.modelExtents(result)
        if (!expanded || !bounds) { return false }
        return [0, 1].every(axis => Math.abs(expanded.low[axis] - bounds.low[axis] + distance) < TOLERANCE && Math.abs(expanded.high[axis] - bounds.high[axis] - distance) < TOLERANCE)
    }
    if (valid(direct)) { return direct }
    let result = clone(model)
    const radii = paths(model).filter(path => path.type === 'arc' && path.radius > EPSILON).map(path => path.radius)
    // Retry failed large arc offsets in steps below the original corner radius.
    const steps = radii.length ? Math.max(2, Math.ceil(distance / Math.min(...radii) * 2)) : 2
    if (steps > MAX_OFFSET_STEPS) { fail('designs', 'Offset exceeds the analytic subdivision limit') }
    for (let step = 0; step < steps; step++) {
        result = m.model.outline(result, distance / steps, joints, false, {farPoint: u.farPoint})
    }
    if (!valid(result)) {
        // Shallow notches between neighboring keys need smaller analytic steps.
        const repairs = Math.ceil(distance / REPAIR_OFFSET_STEP)
        if (repairs > MAX_OFFSET_STEPS) { fail('designs', 'Offset exceeds the analytic subdivision limit') }
        result = clone(model)
        for (let step = 0; step < repairs; step++) {
            result = m.model.outline(result, distance / repairs, joints, false, {farPoint: u.farPoint})
        }
    }
    if (!valid(result)) { fail('designs', 'Offset failed to preserve the profile extent') }
    return result
}
const chains = model => (m.model.findChains(model, {contain: true}) || [])
const partition = model => {
    const contour = chain => ({...m.chain.toNewModel(chain),
        models: Object.fromEntries((chain.contains || []).map((child, index) => [index, contour(child)]))})
    return chains(model).map(contour)
}
const validate = (model, name, connected = 'multiple') => {
    let loose = []
    const contours = m.model.findChains(model, (found, unchained) => { loose = unchained }, {contain: true})
    if (!contours || !contours.length || loose.length || contours.some(chain => !chain.endless)) {
        fail(name, 'Expected nonempty closed contours')
    }
    if (connected === 'single' && contours.length !== 1) {
        fail(name, `Expected one connected region; found ${contours.length}`, 'disconnected')
    }
    const segments = paths(model)
    for (let i = 0; i < segments.length; i++) {
        for (let j = i + 1; j < segments.length; j++) {
            const intersections = m.path.intersection(segments[i], segments[j])
            if (!intersections) { continue }
            const ends = [segments[i], segments[j]].map(path => m.point.fromPathEnds(path) || [])
            for (const point of intersections.intersectionPoints) {
                if (![segments[i], segments[j]].every(path => m.measure.isPointOnPath(point, path, EPSILON))) { continue }
                if (!ends.every(pair => pair.some(end => m.measure.pointDistance(point, end) < EPSILON))) {
                    fail(name, 'Contours intersect', 'intersection')
                }
            }
        }
    }
    return contours.length
}
const contains = (outer, inner) => {
    if (JSON.stringify(outer) === JSON.stringify(inner) || empty(inner)) { return true }
    if (empty(outer)) { return false }
    const outerPaths = paths(outer), innerPaths = paths(inner)
    const boundary = (point, segments) => segments.some(segment => m.measure.isPointOnPath(point, segment, TOLERANCE))
    const inside = (point, model) => m.measure.isPointInsideModel(point, model, {farPoint: u.farPoint})
    // Split analytically before classifying segments, including enclosed cutouts.
    const splitInner = paths(m.model.breakPathsAtIntersections(clone(inner), outer))
    const splitOuter = paths(m.model.breakPathsAtIntersections(clone(outer), inner))
    if (splitInner.some(segment => m.path.toPoints(segment, 3).some(point => !boundary(point, outerPaths) && !inside(point, outer)))) { return false }
    return !splitOuter.some(segment => {
        const point = m.point.middle(segment)
        return !boundary(point, innerPaths) && inside(point, inner)
    })
}
const requireContains = (outer, inner, name) => {
    if (!empty(inner) && !contains(outer, inner)) {
        fail(name, 'Profile removes occupied area or required clearance', 'clearance')
    }
}
const close = (model, radius) => {
    if (!radius) { return clone(model) }
    // Regularize exact tangencies within the documented export tolerance.
    for (const candidateRadius of [radius, radius + TOLERANCE / 10]) {
        try {
            const closed = offset(offset(model, candidateRadius), -candidateRadius)
            validate(closed, 'designs')
            if (contains(closed, model)) { return closed }
            const restored = combine(model, closed)
            m.model.simplify(restored)
            validate(restored, 'designs')
            if (contains(restored, model)) { return restored }
        } catch (error) {
            if (!(error instanceof DesignError)) { throw error }
        }
    }
    fail('designs', 'Gap closing failed to preserve closed occupied geometry')
}
const round = (model, radius) => {
    if (!radius) { return clone(model) }
    // Avoid exact arc collapse during erosion, within the export tolerance.
    for (const candidate of [radius, radius - TOLERANCE / 10]) {
        if (candidate <= 0) { continue }
        const inset = offset(model, -candidate)
        if (empty(inset)) { continue }
        const rounded = offset(inset, candidate)
        if (!empty(rounded)) { return rounded }
    }
    fail('designs', 'Rounding removes the complete profile; reduce its radius')
}
const describe = (model, source) => ({
    source, model: clone(model), bounds: m.measure.modelExtents(model), contours: chains(model).length
})

// Subdivide by the control polygon flatness so exports have a bounded error.
const bezier = (points, tolerance = TOLERANCE) => {
    const result = [points[0]]
    const midpoint = (p, q) => p.map((v, i) => (v + q[i]) / 2)
    const distance = (p, a, b) => {
        const length = m.measure.pointDistance(a, b)
        if (length < EPSILON) { return m.measure.pointDistance(p, a) }
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / length ** 2))
        return m.measure.pointDistance(p, a.map((v, i) => v + t * (b[i] - v)))
    }
    const split = (p, depth) => {
        if (Math.max(distance(p[1], p[0], p[3]), distance(p[2], p[0], p[3])) <= tolerance) {
            result.push(p[3])
            return
        }
        if (depth > 24) { fail('designs.sketches', 'Bézier subdivision limit exceeded') }
        const a = midpoint(p[0], p[1]), b = midpoint(p[1], p[2]), c = midpoint(p[2], p[3])
        const d = midpoint(a, b), e = midpoint(b, c), f = midpoint(d, e)
        split([p[0], a, d, f], depth + 1)
        split([f, e, c, p[3]], depth + 1)
    }
    split(points, 0)
    return new m.models.ConnectTheDots(false, result)
}

module.exports = {TOLERANCE, EPSILON, Joint, DesignError, fail, number, positive, clone, paths, empty,
    combine, union, offset, chains, partition, validate, contains, requireContains, close, round, describe, bezier}
