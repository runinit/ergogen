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
    let activeFeature = 'designs.assemblies'
    try {
        for (const [id, input] of entries) {
            const name = `designs.assemblies.${id}`
            activeFeature = name
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
            let opening = s.opening ? resolve(s.opening).model : g.round(g.offset(base, internalRadius), internalRadius)
            const ring = subtract(exterior, cavity)
            const extents = m.measure.modelExtents(exterior)
            const seam = g.number(s.seam?.z ?? s.plate_z, `${name}.seam.z`, context.units)
            if (seam <= s.floor || seam >= s.height - s.wall) { g.fail(`${name}.seam`, 'Seam must lie between floor and upper bezel') }
            const middleSplit=s.construction==='midframe' ? Math.max(seam+s.wall,s.plate_z+s.plate+(floating?s.gasket.compressed+s.gasket.travel_up+s.gasket.fit:0)) : seam
            if (s.construction==='midframe' && middleSplit>=s.height-s.wall) { g.fail(`${name}.construction`,'Increase shell height to fit the middle frame and top cover.') }

            const lift = s.front_height - s.height * Math.cos(s.typing_angle * RAD)
            const wedge = extents.height * Math.tan(s.typing_angle * RAD) + lift / Math.cos(s.typing_angle * RAD)
            let bottom = kernel.extrude(exterior, s.floor + wedge, -wedge)
            bottom = kernel.add(bottom, kernel.extrude(ring, seam - s.floor, s.floor))
            let top = kernel.extrude(ring, s.height - seam, seam)
            const roof = Math.min(s.wall, s.height - s.plate_z - s.plate)
            let plateModel = s.plate_profile ? resolve(s.plate_profile).model : g.clone(base)
            for (const ref of s.cutouts || []) {
                const cutout = resolve(ref).model
                g.requireContains(opening, cutout, `${name}.opening`)
                plateModel = subtract(plateModel, cutout)
            }
            const plateVoids = g.union(g.chains(plateModel).flatMap(chain => chain.contains || []).map(chain => m.chain.toNewModel(chain)))
            const clearPlate = (model, path) => {
                if (intersects(model, plateVoids)) { g.fail(path, 'Support overlaps a plate cutout', 'clearance') }
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
                    activeFeature = path
                    const tab = shape(definition, path)
                    clearPlate(tab, path)
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
                    const shelf = intersects(pocket, ring) ? pocket : g.combine(pocket, g.combine(ring, g.offset(pocket, s.wall), 'intersect'))
                    bottom = kernel.add(bottom, kernel.extrude(shelf, s.wall, low - s.wall))
                    top = kernel.add(top, kernel.extrude(shelf, s.wall, high))
                    bottom = kernel.cut(bottom, relief)
                    top = kernel.cut(top, relief)
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

            // Cover the contact footprint at roof height while the plate remains an independent part.
            if (floating && s.construction && contacts.length) {
                const concealed=g.union(contacts.map(contact=>g.offset(contact.model,s.gasket.fit+s.gasket.travel_side)))
                opening=subtract(opening,concealed)
                if (internalRadius) {
                    m.model.originate(opening)
                    opening.models ||= {}
                    for (const [index,chain] of g.chains(opening).entries()) {
                        const direction=m.measure.isChainClockwise(chain)?'right':'left'
                        opening.models[`__cover_rounds_${index}`]=m.chain.fillet(chain,{[direction]:internalRadius})
                    }
                }
                for (const ref of s.cutouts || []) { g.requireContains(opening,resolve(ref).model,`${name}.construction`) }
                for (const contact of contacts) { g.requireContains(subtract(exterior,opening),contact.model,`${name}.gaskets.${contact.id}.cover`) }
            }
            top=kernel.add(top,kernel.extrude(subtract(exterior,opening),roof,s.height-roof))

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

            let pcbModel = s.pcb_profile ? resolve(s.pcb_profile).model : null
            for (const hole of context.boards?.[id]?.holes || []) {
                pcbModel = subtract(pcbModel,circle(hole.position,hole.diameter/2))
            }
            const mountTable = {}
            for (const [mountId, mount] of Object.entries(s.mounts || {})) {
                const path = `${name}.mounts.${mountId}`
                activeFeature = path
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
                    clearPlate(envelope, path)
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
                const start = topMount ? (access === 'bottom' ? s.plate_z : Math.max(s.plate_z, s.height - depth))
                    : access === 'bottom' ? 0 : Math.max(0, targetZ - depth)
                const drill = kernel.extrude(circle(p, hole), depth + (role === 'case' ? s.height - seam : s.plate), start)
                if (role === 'case' && mount.clearance && mount.hardware === 'tapped') {
                    const clearance = g.positive(mount.clearance, `${path}.clearance`, context.units)
                    const head = g.positive(mount.head, `${path}.head`, context.units)
                    const headDepth = g.positive(mount.head_depth, `${path}.head_depth`, context.units)
                    if (clearance <= hole || head <= clearance || head >= radius || headDepth >= seam - s.floor) { g.fail(path, 'Screw clearance and head pocket do not fit the closing post') }
                    bottom = kernel.cut(bottom, kernel.extrude(circle(p, clearance), seam))
                    bottom = kernel.cut(bottom, kernel.extrude(circle(p, head), headDepth))
                    if (middleSplit>seam) { top=kernel.cut(top,kernel.extrude(circle(p,clearance),middleSplit-seam,seam)) }
                    top = kernel.cut(top, kernel.extrude(circle(p, hole), Math.min(depth, s.height - middleSplit - s.wall / 2), middleSplit))
                } else {
                    bottom = kernel.cut(bottom, drill)
                    top = kernel.cut(top, drill)
                }
                if (role === 'plate') { plateModel = subtract(plateModel, circle(p, hole)) }
                if (mount.hardware && mount.hardware !== 'plain') {
                    if (!['insert', 'nut', 'tapped'].includes(mount.hardware)) { g.fail(path, 'Unknown fastener type') }
                    if (mount.hardware !== 'tapped') {
                        const pocketRadius = g.positive(mount.pocket, `${path}.pocket`, context.units)
                        const pocketDepth = g.positive(mount.pocket_depth, `${path}.pocket_depth`, context.units)
                        const circumradius = mount.hardware === 'nut' ? pocketRadius / Math.cos(Math.PI / 6) : pocketRadius
                        const available = topMount ? s.height - s.plate_z - s.plate : targetZ
                        if (circumradius + material > radius || pocketDepth + material > available) {
                            g.fail(path, 'Hardware pocket leaves insufficient surrounding material')
                        }
                        const pocketModel = mount.hardware === 'nut'
                            ? m.model.moveRelative(new m.models.Polygon(6, circumradius), p) : circle(p, pocketRadius)
                        hardwarePockets[topMount ? 'top' : 'bottom'].push(pocketModel)
                        const pocketZ = topMount ? (access === 'top' ? s.height - pocketDepth : s.plate_z + s.plate)
                            : access === 'top' ? targetZ - pocketDepth : 0
                        const pocket = kernel.extrude(pocketModel, pocketDepth, pocketZ)
                        if (topMount) { top = kernel.cut(top, pocket) }
                        else { bottom = kernel.cut(bottom, pocket) }
                    }
                }
                if (role === 'case' && mount.screw && access === 'bottom') {
                    const screw=mount.screw
                    const headHeight=g.positive(screw.head_height,`${path}.screw.head_height`,context.units)
                    const headRadius=g.positive(screw.head_diameter,`${path}.screw.head_diameter`,context.units)/2
                    const shankRadius=g.positive(screw.diameter,`${path}.screw.diameter`,context.units)/2
                    if (headHeight>mount.head_depth || headRadius>=mount.head || shankRadius>=mount.clearance) { g.fail(path,'The screw does not fit its head pocket or clearance bore.','hardware') }
                    const topZ=middleSplit+Math.min(depth,s.height-middleSplit-s.wall/2)
                    const head=kernel.extrude(circle(p,headRadius),headHeight)
                    extras[`screws_${mountId}`]=kernel.add(head,kernel.extrude(circle(p,shankRadius),topZ-headHeight,headHeight))
                    extraMotion[`screws_${mountId}`]='fixed'
                }
                holes.push({diameter: hole * 2, access})
                features.push({id: `mounts.${mountId}`, model: envelope, z: topMount ? s.plate_z + s.plate : s.floor,
                    height: topMount ? s.height - s.plate_z - s.plate : (role === 'case' ? s.height : targetZ) - s.floor})
                mountTable[mountId] = {...mount, position: p, role}
            }

            for (const ref of s.openings || []) {
                activeFeature = `${name}.${ref}`
                const definition = config.components[ref.split('.')[1]]
                const [low, high] = definition.height.map(v => g.number(v, `${name}.${ref}.height`, context.units))
                const model = resolve(ref).model
                features.push({id: ref, model, z: low, height: high - low})
                const tool = kernel.extrude(model, high - low, low)
                bottom = kernel.cut(bottom, tool)
                top = kernel.cut(top, tool)
            }
            if (!floating) {
                // Clear the entire plate footprint so holes cannot leave shell pins.
                const footprint = g.union(g.chains(plateModel).map(chain => m.chain.toNewModel(chain)))
                const clearanceModel = g.offset(footprint, s.fit)
                g.requireContains(g.offset(exterior, -s.wall), clearanceModel, `${name}.plate`)
                const relief = kernel.extrude(clearanceModel, s.plate, s.plate_z)
                bottom = kernel.cut(bottom, relief)
                top = kernel.cut(top, relief)
            }
            if (s.fillet) { top = kernel.fillet(top, s.fillet, s.height) }
            if (s.chamfer) { top = kernel.chamfer(top, s.chamfer, s.height) }
            const plate = kernel.extrude(plateModel, s.plate, s.plate_z)
            const parts = {bottom, top, plate}
            if (s.construction === 'midframe') {
                const split = middleSplit
                if (split >= s.height - s.wall) { g.fail(`${name}.construction`, 'Increase shell height to fit the middle frame and top cover') }
                const upper = kernel.extrude(exterior, s.height - split, split)
                parts.middle = kernel.cut(top, upper)
                parts.top = kernel.intersect(top, upper)
                const lip = subtract(g.offset(exterior, -s.wall / 2), g.offset(exterior, -s.wall))
                parts.middle = kernel.add(parts.middle, kernel.extrude(lip, 1, split))
                parts.top = kernel.cut(parts.top, kernel.extrude(g.offset(lip, s.seam?.fit || 0.3), 1.3, split))
            }
            const models = {plate: plateModel}
            const collision = (solid, label) => {
                for (const [part, shell] of Object.entries(Object.fromEntries(Object.entries(parts).filter(([key]) => key !== 'plate')))) {
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
                const tolerance=context.boards?.[id]?.tolerances
                const edge=tolerance?.outline || 0, thickness=tolerance?.thickness || 0
                collision(movement(edge?g.offset(pcbModel,edge):pcbModel,s.pcb_z-(floating?thickness:0),s.pcb_thickness+thickness),'pcb.movement')
                extras.pcb = kernel.extrude(pcbModel, s.pcb_thickness, s.pcb_z)
            }
            for (const ref of s.components || []) {
                activeFeature = `${name}.${ref}`
                const definition = config.components[ref.split('.')[1]]
                const [low, high] = definition.height.map(v => g.number(v, `${name}.${ref}.height`, context.units))
                const model = resolve(ref).model
                collision(definition.motion === 'floating' ? movement(model, low, high - low) : kernel.extrude(model, high - low, low), ref)
                features.push({id: ref, model, z: low, height: high - low})
                extras[ref.replace('.', '_')] = kernel.extrude(model, high - low, low)
                extraMotion[ref.replace('.', '_')] = definition.motion
            }

            const board = context.boards?.[id]
            for (const component of board?.components || []) {
                activeFeature = `${name}.board.models.${component.id}`
                const key=`components_board_${id}_${component.id.replace(/[^A-Za-z0-9_]/g,'_')}`
                if (!extras[key]) { continue }
                const model = await require('./native-models').place(kernel, component, options.assets || {},
                    s.pcb_z + (component.side === 'top' ? board.thickness : 0), activeFeature)
                if (model) { extras[key] = model }
            }

            // Rotate the complete mechanical stack, then trim the bottom to a flat datum.
            const origin = [0, extents.low[1], 0]
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
                middle: Math.min(tooling.radius(cavity), ...contacts.map(contact => tooling.radius(contact.pocket))),
                plate: tooling.radius(platePockets)
            }
            const partReport = {}
            const explodeOrder={bottom:0,plate:1,middle:2,top:s.construction==='midframe'?3:2}
            const findings = []
            for (const part of Object.keys(parts)) {
                const output = `${id}_${part}`
                if (Object.prototype.hasOwnProperty.call(context.cases, output)) { g.fail(name, `Output-name collision: ${output}`) }
                results[output] = await kernel.export(placed[part], output)
                partReport[output] = {slices: [], explode: explodeOrder[part] * s.height,
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
                results[output] = {...await kernel.export(placed[part], output, 'reference'), reference: true}
                partReport[output] = {slices: [], explode: part.startsWith('screws_')?-s.height:s.height, bounds: results[output].bounds,
                    volume: results[output].volume, role: part, reference: true, motion: extraMotion[part]}
            }
            const assembly = Object.fromEntries(Object.entries(placed).map(([part, shape]) => [`${id}_${part}`, shape]))
            const suggestions = [...(report.analysis?.[id]?.suggestions || []), ...(report.analysis?.[id]?.alternatives?.gaskets || [])]
            publish(`${id}_plate`, models.plate, name)
            report.assemblies[id] = {preset: 'enclosure', mounting: s.mounting, parts: partReport,
                suggestions, mounts: mountTable, hardware: Object.fromEntries(Object.entries(mountTable).map(([key, value]) => [key,{thread:value.thread, clearance:(value.clearance || value.hole)*2, receiver:value.hole*2, head:(value.head || 0)*2}])), placement: {origin, angle: s.typing_angle, lift},
                features: features.map(feature => {
                    const box = m.measure.modelExtents(feature.model)
                    return {...feature, bounds: [[...box.low, feature.z], [...box.high, feature.z + feature.height]]}
                }), manufacturing: findings.map(f=>({...f,sourcePath:f.feature,explanation:f.message,repairs:[{id:'review',label:f.action || 'Review manufacturing settings for this part.',path:f.feature}]})),
                gasket: floating ? s.gasket : undefined, parameters: s,
                step: await kernel.assembly(assembly)}
        }
        return results
    } catch (error) {
        if (error.diagnostics) { throw error }
        g.fail(activeFeature, error.message || 'CAD could not combine these features. Inspect their contact faces and clearance, then retry generation.', 'cad')
    } finally { kernel.close() }
}
