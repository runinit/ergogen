const m = require('makerjs')
const g = require('./geometry')
const {normalize} = require('./enclosure-spec')
const manufacturing = require('./manufacturing')
const tooling = require('./tooling')

const circle = (p, radius) => ({paths: {circle: new m.paths.Circle(p, radius)}})
const rect = (p, size) => m.model.moveRelative(m.model.center(new m.models.Rectangle(...size)), p)
const subtract = (left, right) => g.combine(left, right, 'subtract')
const intersects = (left, right) => !g.empty(g.combine(left, right, 'intersect'))
const RAD = Math.PI / 180

// Compile a mechanical assembly once; every export comes from these same solids.
exports.compile = async (config, context, options = {}) => {
    const entries = Object.entries(config.assemblies || {}).filter(([, spec]) => spec.preset === 'enclosure')
    if (!entries.length) { return {} }
    const kernel = await require('./solid-kernel').open(options)
    const results = {}
    try {
        for (const [id, input] of entries) {
            const name = `designs.assemblies.${id}`
            const s = normalize(input, name, context.units)
            const {resolve, locate, shape, publish, report} = context
            const base = resolve(s.profile).model
            g.validate(base, `${name}.profile`, 'single')
            const internalRadius = g.number(s.internal_radius || 0, `${name}.internal_radius`, context.units)
            const floating = s.mounting === 'gasket'
            const clearance = Math.max(s.fit, internalRadius) + (floating ? s.gasket.travel_side : 0)
            if (clearance >= s.bezel) { g.fail(name, 'Increase bezel width to retain walls around the cavity') }
            const cavity = g.round(g.offset(base, clearance), internalRadius)
            const exterior = g.offset(base, s.bezel + s.wall)
            const opening = s.opening ? resolve(s.opening).model : g.round(g.offset(base, internalRadius), internalRadius)
            const ring = subtract(exterior, cavity)
            const bezel = subtract(exterior, opening)
            const extents = m.measure.modelExtents(exterior)
            const seam = g.number(s.seam?.z ?? s.plate_z, `${name}.seam.z`, context.units)
            if (seam <= s.floor || seam >= s.height - s.wall) { g.fail(`${name}.seam`, 'Seam must lie between floor and upper bezel') }
            const wedge = extents.height * Math.tan(s.typing_angle * RAD)
            let bottom = kernel.extrude(exterior, s.floor + wedge, -wedge)
            bottom = kernel.add(bottom, kernel.extrude(ring, seam - s.floor, s.floor))
            let top = kernel.extrude(ring, s.height - seam, seam)
            const roof = Math.min(s.wall, s.height - s.plate_z - s.plate)
            top = kernel.add(top, kernel.extrude(bezel, roof, s.height - roof))
            let plateModel = s.plate_profile ? resolve(s.plate_profile).model : g.clone(base)
            for (const ref of s.cutouts || []) {
                const cutout = resolve(ref).model
                g.requireContains(opening, cutout, `${name}.opening`)
                plateModel = subtract(plateModel, cutout)
            }
            const contacts = []
            const extras = {}, extraMotion = {}
            const hardwarePockets = {bottom: [], top: []}
            const holes = []
            const features = []

            // Gasket pockets clear the floating tabs; shelves stop at compressed pads.
            if (floating) {
                for (const [tabId, definition] of Object.entries(s.gaskets)) {
                    const path = `${name}.gaskets.${tabId}`
                    const tab = shape(definition, path)
                    if (!intersects(tab, base)) { g.fail(path, 'Gasket tab must overlap the plate') }
                    const sleeveMargin = s.gasket.kind === 'sleeves' ? s.gasket.thickness : 0
                    const pocketClearance = Math.max(sleeveMargin + s.gasket.fit + s.gasket.travel_side, internalRadius)
                    const pocket = g.round(g.offset(tab, pocketClearance), internalRadius)
                    g.requireContains(g.offset(exterior, -s.wall), pocket, path)
                    plateModel = g.combine(plateModel, tab)
                    const low = s.plate_z - s.gasket.compressed
                    const high = s.plate_z + s.plate + s.gasket.compressed
                    if (low - s.wall <= s.floor || high + s.wall >= s.height) {
                        g.fail(path, 'Increase case height or adjust plate height for gasket shelves')
                    }
                    const relief = kernel.extrude(pocket, high - low, low)
                    bottom = kernel.cut(bottom, relief)
                    top = kernel.cut(top, relief)
                    const shelf = g.combine(pocket, g.combine(ring, g.offset(pocket, s.wall), 'intersect'))
                    bottom = kernel.add(bottom, kernel.extrude(shelf, s.wall, low - s.wall))
                    top = kernel.add(top, kernel.extrude(shelf, s.wall, high))
                    if (s.gasket.kind === 'sleeves') {
                        const sleeveOuter = g.offset(tab, s.gasket.thickness)
                        g.requireContains(exterior, sleeveOuter, path)
                        let sleeve = kernel.extrude(sleeveOuter, high - low, low)
                        sleeve = kernel.cut(sleeve, kernel.extrude(g.offset(tab, s.gasket.fit), s.plate, s.plate_z))
                        extras[`gasket_${tabId}`] = sleeve
                    } else {
                        extras[`gasket_${tabId}_lower`] = kernel.extrude(tab, s.gasket.compressed, low)
                        extras[`gasket_${tabId}_upper`] = kernel.extrude(tab, s.gasket.compressed, s.plate_z + s.plate)
                    }
                    contacts.push({id: tabId, model: tab, pocket, low, high})
                    features.push({id: `gaskets.${tabId}`, model: pocket, z: low, height: high - low})
                }
            }

            // Optional continuous ledge belongs to the fixed plate support system.
            if (s.ledge) {
                if (floating) { g.fail(`${name}.ledge`, 'A rigid ledge would clamp the floating plate') }
                const width = g.positive(s.ledge.width, `${name}.ledge.width`, context.units)
                const thickness = g.positive(s.ledge.thickness, `${name}.ledge.thickness`, context.units)
                const ledge = subtract(exterior, g.offset(base, -width))
                const z = s.plate_z - thickness
                bottom = kernel.add(bottom, kernel.extrude(ledge, thickness, z))
            }

            // A registration lip aligns shells without joining their exported solids.
            if (s.seam?.type === 'stepped') {
                const depth = g.positive(s.seam.depth, `${name}.seam.depth`, context.units)
                const fit = g.positive(s.seam.fit, `${name}.seam.fit`, context.units)
                if (depth >= s.height - seam || fit >= s.wall / 2) { g.fail(`${name}.seam`, 'Registration step exceeds available wall material') }
                const lip = subtract(g.offset(exterior, -s.wall / 2), g.offset(exterior, -s.wall))
                bottom = kernel.add(bottom, kernel.extrude(lip, depth, seam))
                top = kernel.cut(top, kernel.extrude(g.offset(lip, fit), depth + fit, seam))
            }

            const pcbModel = s.pcb_profile ? resolve(s.pcb_profile).model : null
            const mountTable = {}
            for (const [mountId, mount] of Object.entries(s.mounts || {})) {
                const path = `${name}.mounts.${mountId}`
                const p = locate(mount.anchor, `${path}.anchor`).p
                const role = mount.role || 'case'
                if (!['case', 'plate', 'pcb'].includes(role)) { g.fail(path, 'Unknown mounting target') }
                if (floating && role !== 'case') { g.fail(path, 'Rigid posts cannot support the floating plate or PCB') }
                if (role === 'pcb' && !pcbModel) { g.fail(path, 'PCB supports require a declared PCB profile') }
                const radius = g.positive(mount.post, `${path}.post`, context.units)
                const hole = g.positive(mount.hole, `${path}.hole`, context.units)
                const envelope = circle(p, radius)
                const material = g.number(mount.min_wall ?? s.wall / 2, `${path}.min_wall`, context.units)
                if (radius - hole < material) { g.fail(path, 'Post has insufficient material around its hole') }
                g.requireContains(exterior, envelope, path)
                const targetZ = role === 'pcb' ? s.pcb_z : role === 'plate' ? s.plate_z : seam
                if (targetZ <= s.floor) { g.fail(path, 'Support height must be above the floor') }
                const topMount = role === 'plate' && s.mounting === 'top'
                if (role === 'plate') {
                    if (!intersects(base, envelope)) { g.fail(path, 'Plate mounting tab must overlap the plate') }
                    plateModel = g.combine(plateModel, envelope)
                }
                if (topMount) {
                    top = kernel.add(top, kernel.extrude(envelope, s.height - s.plate_z - s.plate, s.plate_z + s.plate))
                } else {
                    bottom = kernel.add(bottom, kernel.extrude(envelope, targetZ - s.floor, s.floor))
                }
                if (role === 'case') { top = kernel.add(top, kernel.extrude(envelope, s.height - seam, seam)) }
                const depth = g.positive(mount.depth ?? s.height, `${path}.depth`, context.units)
                const access = mount.access || 'top'
                if (!['top', 'bottom'].includes(access)) { g.fail(path, 'Hardware insertion must be top or bottom') }
                const start = topMount ? s.plate_z : access === 'bottom' ? 0 : Math.max(0, targetZ - depth)
                const drill = kernel.extrude(circle(p, hole), depth + (role === 'case' ? s.height - seam : s.plate), start)
                bottom = kernel.cut(bottom, drill)
                top = kernel.cut(top, drill)
                if (role === 'plate') { plateModel = subtract(plateModel, circle(p, hole)) }
                if (mount.hardware && mount.hardware !== 'plain') {
                    if (!['insert', 'nut', 'tapped'].includes(mount.hardware)) { g.fail(path, 'Unknown fastener type') }
                    if (mount.hardware !== 'tapped') {
                        const pocketRadius = g.positive(mount.pocket, `${path}.pocket`, context.units)
                        const pocketDepth = g.positive(mount.pocket_depth, `${path}.pocket_depth`, context.units)
                        const circumradius = mount.hardware === 'nut' ? pocketRadius / Math.cos(Math.PI / 6) : pocketRadius
                        if (circumradius + material > radius || pocketDepth + material > targetZ) {
                            g.fail(path, 'Hardware pocket leaves insufficient surrounding material')
                        }
                        const pocketModel = mount.hardware === 'nut'
                            ? m.model.moveRelative(new m.models.Polygon(6, circumradius), p) : circle(p, pocketRadius)
                        hardwarePockets[topMount ? 'top' : 'bottom'].push(pocketModel)
                        const pocketZ = topMount ? s.plate_z + s.plate : access === 'top' ? targetZ - pocketDepth : 0
                        const pocket = kernel.extrude(pocketModel, pocketDepth, pocketZ)
                        if (topMount) { top = kernel.cut(top, pocket) }
                        else { bottom = kernel.cut(bottom, pocket) }
                    }
                }
                holes.push({diameter: hole * 2, access})
                features.push({id: `mounts.${mountId}`, model: envelope, z: s.floor, height: targetZ - s.floor})
                mountTable[mountId] = {...mount, position: p, role}
            }

            for (const ref of s.openings || []) {
                const definition = config.components[ref.split('.')[1]]
                const [low, high] = definition.height.map(v => g.number(v, `${name}.${ref}.height`, context.units))
                const tool = kernel.extrude(resolve(ref).model, high - low, low)
                bottom = kernel.cut(bottom, tool)
                top = kernel.cut(top, tool)
            }
            if (!floating) {
                const clearanceModel = g.offset(plateModel, s.fit)
                g.requireContains(g.offset(exterior, -s.wall), clearanceModel, `${name}.plate`)
                const relief = kernel.extrude(clearanceModel, s.plate, s.plate_z)
                bottom = kernel.cut(bottom, relief)
                top = kernel.cut(top, relief)
            }
            if (s.fillet) { top = kernel.fillet(top, s.fillet, s.height) }
            if (s.chamfer) { top = kernel.chamfer(top, s.chamfer, s.height) }
            const plate = kernel.extrude(plateModel, s.plate, s.plate_z)
            const parts = {bottom, top, plate}
            const models = {plate: plateModel}
            const collision = (solid, label) => {
                for (const [part, shell] of Object.entries({bottom, top})) {
                    if (kernel.volume(kernel.intersect(shell, solid)) > g.TOLERANCE) {
                        g.fail(`${name}.${label}`, `Clearance conflict with ${part} shell`, 'clearance')
                    }
                }
            }
            const movement = (model, z, thickness) => {
                const shape = floating ? g.offset(model, s.gasket.travel_side) : model
                const down = floating ? s.gasket.travel_down : 0
                const up = floating ? s.gasket.travel_up : 0
                return kernel.extrude(shape, thickness + down + up, z - down)
            }
            collision(movement(plateModel, s.plate_z, s.plate), 'plate.movement')
            if (pcbModel) {
                collision(movement(pcbModel, s.pcb_z, s.pcb_thickness), 'pcb.movement')
                extras.pcb = kernel.extrude(pcbModel, s.pcb_thickness, s.pcb_z)
            }
            for (const ref of s.components || []) {
                const definition = config.components[ref.split('.')[1]]
                const [low, high] = definition.height.map(v => g.number(v, `${name}.${ref}.height`, context.units))
                const model = resolve(ref).model
                collision(definition.motion === 'floating' ? movement(model, low, high - low) : kernel.extrude(model, high - low, low), ref)
                extras[ref.replace('.', '_')] = kernel.extrude(model, high - low, low)
                extraMotion[ref.replace('.', '_')] = definition.motion
            }

            // Rotate the complete mechanical stack, then trim the bottom to a flat datum.
            const origin = [0, extents.low[1], 0]
            const lift = s.front_height - s.height * Math.cos(s.typing_angle * RAD)
            const placed = {}
            for (const [part, solid] of Object.entries({...parts, ...extras})) {
                placed[part] = kernel.move(kernel.rotate(solid, s.typing_angle, origin), [0, 0, lift])
            }
            if (s.typing_angle || lift) {
                const box = kernel.bounds(placed.bottom)
                const crop = rect([(box[0][0] + box[1][0]) / 2, (box[0][1] + box[1][1]) / 2],
                    [box[1][0] - box[0][0] + s.wall, box[1][1] - box[0][1] + s.wall])
                placed.bottom = kernel.intersect(placed.bottom, kernel.extrude(crop, box[1][2] + s.wall))
            }
            const platePockets = {models: Object.fromEntries(g.chains(plateModel).flatMap(chain => chain.contains || []).map((chain, index) => [index, m.chain.toNewModel(chain)]))}
            const pocketRadius = {
                bottom: Math.min(tooling.radius(cavity), ...contacts.map(contact => tooling.radius(contact.pocket)), ...hardwarePockets.bottom.map(tooling.radius)),
                top: Math.min(tooling.radius(cavity), tooling.radius(opening), ...contacts.map(contact => tooling.radius(contact.pocket)), ...hardwarePockets.top.map(tooling.radius)),
                plate: tooling.radius(platePockets)
            }
            const partReport = {}
            const findings = []
            for (const part of Object.keys(parts)) {
                const output = `${id}_${part}`
                if (Object.prototype.hasOwnProperty.call(context.cases, output)) { g.fail(name, `Output-name collision: ${output}`) }
                results[output] = await kernel.export(placed[part], output)
                partReport[output] = {slices: [], explode: Object.keys(partReport).length * s.height,
                    bounds: results[output].bounds, volume: results[output].volume, role: part}
                findings.push(...manufacturing.check(`${name}.${part}`, s.manufacturing?.[part], {
                    wall: part === 'plate' ? s.plate : Math.min(s.wall, s.floor),
                    depth: results[output].bounds[1][2] - results[output].bounds[0][2],
                    width: results[output].bounds[1][0] - results[output].bounds[0][0],
                    height: results[output].bounds[1][1] - results[output].bounds[0][1],
                    holes, fillet: pocketRadius[part], sideOpenings: part !== 'plate' && s.openings?.length,
                    angle: s.typing_angle, overhang: floating || Boolean(s.ledge)
                }))
            }
            for (const part of Object.keys(extras)) {
                const output = `${id}_${part}`
                results[output] = {...await kernel.export(placed[part], output), reference: true}
                partReport[output] = {slices: [], explode: s.height, bounds: results[output].bounds,
                    volume: results[output].volume, role: part, reference: true, motion: extraMotion[part]}
            }
            const assembly = Object.fromEntries(Object.entries(placed).map(([part, shape]) => [`${id}_${part}`, shape]))
            const suggest = require('./mounts').suggest
            const suggestionContext = {base, exterior, units: context.units, name, shape,
                mounts: mountTable, exclusions: [], components: [], gasketModels: contacts.map(contact => contact.model), height: s.height}
            const suggestions = suggest({...s, suggest: {gaskets: {spacing: 40, size: [10, 6]}}}, suggestionContext)
            suggestions.push(...suggest({...s, suggest: {spacing: 40, inset: 1, post: 2.5, hole: 1, height: seam - s.floor}},
                {...suggestionContext, base: g.offset(base, s.bezel / 2 + 1),
                    exclusions: [g.offset(plateModel, s.fit + (floating ? s.gasket.travel_side : 0)),
                        ...contacts.map(contact => contact.pocket)]}).map(item => ({...item, definition: {...item.definition, role: 'case'}})))
            publish(`${id}_plate`, models.plate, name)
            report.assemblies[id] = {preset: 'enclosure', mounting: s.mounting, parts: partReport,
                suggestions, mounts: mountTable, features, manufacturing: findings,
                gasket: floating ? s.gasket : undefined, parameters: s,
                step: await kernel.assembly(assembly)}
        }
        return results
    } finally { kernel.close() }
}
