const m = require('makerjs')
const a = require('../assert')
const filter = require('../filter')
const anchor = require('../anchor').parse
const Point = require('../point')
const g = require('./geometry')

const sections = ['regions', 'boundaries', 'sketches', 'profiles', 'components', 'assemblies']
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

exports.parse = async (config, points, outlines, units, options = {}) => {
    a.unexpected(config, 'designs', sections)
    const features = {}, resolved = {}, active = new Set(), generated = {}, cases = {}
    const report = {features, diagnostics: [], adjustments: [], assemblies: {}, tolerance: g.TOLERANCE}
    const dim = (value, name) => g.number(value, name, units)

    const locate = (spec, name) => {
        if (spec && typeof spec === 'object' && spec.feature) {
            const target = resolve(spec.feature)
            const bounds = m.measure.modelExtents(target.model)
            const point = new Point(...bounds.low.map((v, i) => (v + bounds.high[i]) / 2))
            return anchor({shift: spec.shift || [0, 0], rotate: spec.rotate || 0}, name, points, point)(units)
        }
        try { return anchor(spec || {}, name, points)(units) }
        catch (error) { g.fail(name, error.message, 'reference') }
    }
    const shape = (spec, name, point = locate(spec.anchor, `${name}.anchor`)) => {
        let model
        if (spec.radius !== undefined) {
            model = {paths: {circle: new m.paths.Circle([0, 0], g.positive(spec.radius, `${name}.radius`, units))}}
        } else {
            const scope = {...units, ...point.meta}
            const size = a.wh(spec.size || [point.meta.width, point.meta.height], `${name}.size`)(scope)
            size.forEach(value => g.positive(value, `${name}.size`))
            const corner = g.number(spec.corner_radius || 0, `${name}.corner_radius`, scope)
            if (corner < 0 || corner > Math.min(...size) / 2) { g.fail(name, 'Corner radius must fit the declared width and length') }
            model = m.model.center(corner ? new m.models.RoundRectangle(...size, corner) : new m.models.Rectangle(...size))
        }
        return point.position(model)
    }
    const publish = (name, model, source) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            g.fail(source, `Invalid output name ${name}`)
        }
        if (own(outlines, name) || own(generated, name)) {
            g.fail(source, `Output-name collision: ${name}`, 'collision')
        }
        generated[name] = model
    }
    const modify = (model, spec, name, occupied) => {
        for (const [id, modification] of Object.entries(spec.modifications || {})) {
            const path = `${name}.modifications.${id}`
            const tool = modification.from ? resolve(modification.from).model : shape(modification, path)
            model = g.combine(model, tool, modification.operation || 'add')
            g.validate(model, path)
            g.requireContains(model, occupied, path)
            features[path.slice('designs.'.length)] = g.describe(tool, path)
        }
        return model
    }
    const finish = (model, spec, name, occupied) => {
        const clearance = dim(spec.clearance || 0, `${name}.clearance`)
        const rounding = dim(spec.round || 0, `${name}.round`)
        if (rounding < 0) { g.fail(name, 'Rounding must be nonnegative') }
        model = g.offset(model, clearance)
        model = g.round(model, rounding)
        const required = !g.empty(occupied) && clearance > 0 ? g.offset(occupied, clearance) : occupied
        model = modify(model, spec, name, required)
        g.validate(model, name, spec.connected || 'multiple')
        g.requireContains(model, required, name)
        return model
    }
    const resolve = ref => {
        if (typeof ref !== 'string') { g.fail('designs', 'Expected a named feature reference', 'reference') }
        if (own(resolved, ref)) { return resolved[ref] }
        if (active.has(ref)) { g.fail(`designs.${ref}`, `Cyclic design reference: ${[...active, ref].join(' -> ')}`, 'cycle') }
        const [section, id, ...tail] = ref.split('.')
        const name = `designs.${ref}`
        if (tail.length || !config[section] || !own(config[section], id)) { g.fail(name, 'Missing named feature; repair the reference', 'reference') }
        const spec = config[section][id]
        if (!spec || typeof spec !== 'object') { g.fail(name, 'Expected a feature mapping') }
        active.add(ref)
        try {
            let model, occupied = {paths: {}}, groups = []
            if (section === 'regions') {
                a.unexpected(spec, name, ['where', 'asym', 'size', 'corner_radius', 'outline', 'close', 'clearance', 'round', 'connected', 'modifications'])
                if (spec.outline) {
                    if (!own(outlines, spec.outline)) { g.fail(name, `Missing outline ${spec.outline}`, 'reference') }
                    groups = [g.clone(outlines[spec.outline])]
                } else {
                    const selected = filter.parse(spec.where ?? true, `${name}.where`, points, units, a.asym(spec.asym || 'source', name))
                    // Close each half independently, even when their gap is small.
                    for (const mirrored of [false, true]) {
                        const models = selected.filter(p => !!p.meta.mirrored === mirrored && !p.meta.skip).map(p => shape(spec, name, p.clone()))
                        if (models.length) { groups.push(g.union(models)) }
                    }
                }
                occupied = g.union(groups)
                const radius = dim(spec.close || 0, `${name}.close`)
                if (radius < 0) { g.fail(name, 'Gap-closing radius must be nonnegative') }
                groups = groups.map(group => finish(g.close(group, radius), spec, name, group))
                model = g.union(groups)
                if (g.chains(model).length < groups.reduce((count, group) => count + g.chains(group).length, 0)) {
                    g.fail(name, 'Clearance joins separated halves; use a named bridge', 'disconnected')
                }
            } else if (section === 'boundaries' || section === 'profiles') {
                a.unexpected(spec, name, ['from', 'close', 'clearance', 'round', 'connected', 'modifications', 'bridges', 'cutouts'])
                const refs = Array.isArray(spec.from) ? spec.from : [spec.from]
                const sources = refs.map(resolve)
                occupied = g.union(sources.map(source => source.occupied))
                groups = sources.flatMap(source => source.groups)
                const radius = dim(spec.close || 0, `${name}.close`)
                if (radius < 0) { g.fail(name, 'Gap-closing radius must be nonnegative') }
                groups = groups.map(group => g.close(group, radius))
                model = g.union(groups)
                for (const [bridge, bridgeSpec] of Object.entries(spec.bridges || {})) {
                    const path = `${name}.bridges.${bridge}`
                    const from = locate(bridgeSpec.from, `${path}.from`).p
                    const to = locate(bridgeSpec.to, `${path}.to`).p
                    const width = g.positive(bridgeSpec.width, `${path}.width`, units)
                    if (m.measure.pointDistance(from, to) < g.EPSILON) { g.fail(path, 'Bridge anchors coincide') }
                    const bridgeModel = new m.models.Slot(from, to, width / 2)
                    for (const point of [from, to]) {
                        if (!m.measure.isPointInsideModel(point, model)) { g.fail(path, 'Bridge attachment is outside its region') }
                    }
                    model = g.combine(model, bridgeModel)
                    features[`${ref}.bridges.${bridge}`] = g.describe(bridgeModel, path)
                }
                const before = g.chains(model).length
                model = finish(model, spec, name, occupied)
                if (!Object.keys(spec.bridges || {}).length && g.chains(model).length < before) {
                    g.fail(name, 'Profiles cannot join separate regions without a named bridge', 'disconnected')
                }
                // Intentional cutouts remove material after occupied-area validation.
                for (const cutout of spec.cutouts || []) {
                    model = g.combine(model, resolve(cutout).model, 'subtract')
                    g.validate(model, `${name}.cutouts`)
                }
                groups = g.partition(model)
                if (section === 'profiles') { publish(id, model, name) }
            } else if (section === 'components') {
                a.unexpected(spec, name, ['anchor', 'size', 'radius', 'corner_radius', 'height', 'clearance', 'motion'])
                model = shape(spec, name)
                const height = a.numarr(spec.height, `${name}.height`, 2)(units)
                if (height[0] >= height[1]) { g.fail(name, 'Height range must increase') }
                model = g.offset(model, dim(spec.clearance || 0, `${name}.clearance`))
                occupied = model
                groups = [model]
            } else if (section === 'sketches') {
                const sketch = solvedSketches[id]
                model = sketch.model
                groups = [model]
                report.adjustments.push(...sketch.adjustments)
                features[ref] = {...g.describe(model, name), sketch: sketch.geometry, constraints: spec.constraints || {}}
            } else { g.fail(name, 'Cannot use an assembly as a 2D reference') }
            active.delete(ref)
            resolved[ref] = {model, occupied, groups}
            features[ref] = {...g.describe(model, name), ...features[ref]}
            return resolved[ref]
        } catch (error) {
            if (error instanceof g.DesignError && error.diagnostics[0].feature === 'designs') { g.fail(name, error.diagnostics[0].message, error.diagnostics[0].code) }
            throw error
        } finally { active.delete(ref) }
    }

    // Solving is asynchronous; the geometry graph remains deterministic afterwards.
    const solvedSketches = {}
    for (const [id, sketch] of Object.entries(config.sketches || {})) {
        const solver = require('./sketches')
        solvedSketches[id] = await solver.parse(sketch, `designs.sketches.${id}`, units, points, options)
    }
    for (const section of sections.filter(section => section !== 'assemblies')) {
        for (const id of Object.keys(config[section] || {})) { resolve(`${section}.${id}`) }
    }
    if (Object.keys(config.assemblies || {}).length) {
        const assemblies = require('./assemblies')
        const legacy = Object.fromEntries(Object.entries(config.assemblies).filter(([, spec]) => spec.preset !== 'enclosure'))
        assemblies.compile({...config, assemblies: legacy}, {resolve, locate, shape, publish, units, cases, report, outlines: generated})
    }
    const solids = await require('./enclosures').compile(config, {resolve, locate, shape, publish, units, cases, report}, options)
    return {outlines: generated, cases, report, solids}
}
