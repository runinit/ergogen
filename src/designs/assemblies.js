const m = require('makerjs')
const a = require('../assert')
const g = require('./geometry')

const circle = (position, radius) => ({paths: {circle: new m.paths.Circle(position, radius)}})
const intersects = (left, right) => !g.empty(g.combine(left, right, 'intersect'))

exports.compile = (config, context) => {
    const {resolve, locate, shape, publish, units, cases, report} = context
    for (const [id, spec] of Object.entries(config.assemblies || {})) {
        const name = `designs.assemblies.${id}`
        a.unexpected(spec, name, ['preset', 'profile', 'wall', 'floor', 'height', 'plate', 'fit', 'lid', 'layers', 'mounts', 'gasket', 'gaskets', 'cutouts', 'components', 'openings', 'suggest', 'exclusions'])
        a.in(spec.preset, `${name}.preset`, ['plate', 'tray', 'stacked', 'gasket'])
        const dim = (key, fallback) => g.positive(spec[key] ?? fallback, `${name}.${key}`, units)
        const fit = g.number(spec.fit ?? 0, `${name}.fit`, units)
        if (fit < 0) { g.fail(name, 'Fit allowance must be nonnegative') }
        const base = resolve(spec.profile).model
        g.validate(base, name, 'single')
        const plateThickness = dim('plate', 1.5), floor = dim('floor', 2), height = dim('height', 10), wall = dim('wall', 3)
        const cavity = g.offset(base, fit), exterior = g.offset(cavity, wall)
        const ring = g.combine(exterior, cavity, 'subtract')
        const parts = {}, mounts = {}, suggestions = []
        report.assemblies[id] = {preset: spec.preset, parts, mounts, suggestions}
        const components = (spec.components || []).map(ref => ({ref, model: resolve(ref).model,
            height: a.numarr(config.components[ref.split('.')[1]]?.height, `${name}.${ref}.height`, 2)(units)}))
        const exclusions = (spec.exclusions || []).map(ref => resolve(ref).model)
        const openings = (spec.openings || []).map(ref => ({ref, model: resolve(ref).model,
            height: a.numarr(config.components[ref.split('.')[1]]?.height, `${name}.${ref}.height`, 2)(units)}))
        for (const [mountId, mount] of Object.entries(spec.mounts || {})) {
            const path = `${name}.mounts.${mountId}`
            a.unexpected(mount, path, ['anchor', 'hole', 'post', 'height'])
            const position = locate(mount.anchor, `${path}.anchor`).p
            const hole = g.positive(mount.hole, `${path}.hole`, units), post = g.positive(mount.post, `${path}.post`, units)
            const postHeight = g.positive(mount.height ?? height, `${path}.height`, units)
            if (hole >= post || postHeight > height) { g.fail(path, 'Post must surround its hole and fit below the lid') }
            const envelope = circle(position, post)
            g.requireContains(exterior, envelope, path)
            if (exclusions.some(model => intersects(envelope, model))) { g.fail(path, 'Mount intersects an exclusion') }
            mounts[mountId] = {position, hole, post, height: postHeight, anchor: mount.anchor}
        }
        const holes = g.union(Object.values(mounts).map(mount => circle(mount.position, mount.hole)))
        const cutouts = g.union((spec.cutouts || []).map(ref => resolve(ref).model))
        let plate = g.combine(base, cutouts, 'subtract')
        const gasketModels = []
        for (const [gasketId, gasket] of Object.entries(spec.gaskets || {})) {
            const tab = shape(gasket, `${name}.gaskets.${gasketId}`)
            if (!intersects(tab, base)) { g.fail(`${name}.gaskets.${gasketId}`, 'Gasket tab must attach to the plate') }
            g.requireContains(exterior, tab, `${name}.gaskets.${gasketId}`)
            gasketModels.push(tab)
            plate = g.combine(plate, tab)
        }
        plate = g.combine(plate, holes, 'subtract')

        // Each slice uses existing outline extrusion; holes share the mount table.
        const emit = (partId, slices) => {
            const output = `${id}_${partId}`
            const ops = [], layers = []
            for (const [index, slice] of slices.entries()) {
                if (slice.thickness <= 0) { g.fail(name, 'Part thickness must be positive') }
                let model = g.combine(slice.model, holes, 'subtract')
                if (g.empty(model)) { continue }
                g.validate(model, `${name}.${partId}`)
                const outline = `_design_${output}_${index}`
                publish(outline, model, name)
                ops.push({name: outline, extrude: slice.thickness, shift: [0, 0, slice.z]})
                layers.push({model, z: slice.z, thickness: slice.thickness})
            }
            for (const opening of openings) {
                const outline = `_design_${output}_opening_${ops.length}`
                publish(outline, opening.model, name)
                ops.push({name: outline, operation: 'subtract', extrude: opening.height[1] - opening.height[0], shift: [0, 0, opening.height[0]]})
            }
            for (const component of components) {
                for (const slice of layers) {
                    if (component.height[1] <= slice.z + g.EPSILON || component.height[0] >= slice.z + slice.thickness - g.EPSILON) { continue }
                    let material = slice.model
                    for (const opening of openings) {
                        if (opening.height[0] <= component.height[0] && opening.height[1] >= component.height[1]) { material = g.combine(material, opening.model, 'subtract') }
                    }
                    if (intersects(material, component.model)) { g.fail(`${name}.${partId}`, `Clearance conflict with ${component.ref}`, 'clearance') }
                }
            }
            if (!ops.length) { g.fail(name, `Empty part ${partId}`) }
            cases[output] = ops
            parts[output] = {slices: layers, explode: Object.keys(parts).length * (height + floor), source: name}
        }
        const posts = z => Object.values(mounts).map(mount => ({model: circle(mount.position, mount.post), z, thickness: mount.height}))
        if (spec.preset === 'plate') { emit('plate', [{model: plate, z: 0, thickness: plateThickness}]) }
        if (spec.preset === 'tray') {
            emit('tray', [{model: exterior, z: 0, thickness: floor}, {model: ring, z: floor, thickness: height}, ...posts(floor)])
            if (spec.lid) { emit('lid', [{model: exterior, z: floor + height, thickness: g.positive(spec.lid, `${name}.lid`, units)}]) }
        }
        if (spec.preset === 'stacked') {
            let z = 0
            if (!Object.keys(spec.layers || {}).length) { g.fail(name, 'Stacked cases require named layers') }
            for (const [layer, settings] of Object.entries(spec.layers)) {
                a.unexpected(settings, `${name}.layers.${layer}`, ['thickness', 'cavity', 'profile'])
                const thickness = g.positive(settings.thickness, `${name}.layers.${layer}.thickness`, units)
                const model = settings.profile ? resolve(settings.profile).model : settings.cavity ? ring : exterior
                emit(layer, [{model, z, thickness}])
                z += thickness
            }
        }
        if (spec.preset === 'gasket') {
            if (!gasketModels.length) { g.fail(name, 'Gasket enclosures require named gasket tabs') }
            const gasket = spec.gasket || {}
            const thickness = g.positive(gasket.thickness, `${name}.gasket.thickness`, units)
            const compression = g.number(gasket.compression, `${name}.gasket.compression`, units)
            const allowance = g.number(gasket.fit, `${name}.gasket.fit`, units)
            if (compression < 0 || compression >= 1 || allowance < 0) { g.fail(name, 'Invalid gasket compression or fit') }
            const compressed = thickness * (1 - compression)
            const pockets = g.offset(g.union(gasketModels), allowance)
            const support = g.combine(exterior, g.combine(cavity, pockets), 'subtract')
            const ledge = g.combine(exterior, g.combine(g.offset(base, -wall), pockets), 'subtract')
            const plateZ = floor + height
            emit('bottom', [{model: exterior, z: 0, thickness: floor}, {model: ring, z: floor, thickness: height - compressed},
                {model: ledge, z: plateZ - compressed - floor, thickness: floor}, {model: support, z: plateZ - compressed, thickness: compressed}, ...posts(floor)])
            emit('plate', [{model: plate, z: plateZ, thickness: plateThickness}])
            emit('top', [{model: support, z: plateZ + plateThickness, thickness: compressed},
                {model: ledge, z: plateZ + plateThickness + compressed, thickness: floor}])
            report.assemblies[id].gasket = {thickness, compression, compressed, fit: allowance}
        }
        suggestions.push(...require('./mounts').suggest(spec, {
            base, exterior, units, name, shape, mounts, exclusions, components, gasketModels, height
        }))
    }
}
