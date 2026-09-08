const m = require('makerjs')
const g = require('./geometry')
const {suggest} = require('./mounts')
const SPACING = 40
const TAB_ENGAGEMENT = 0.5
const intersects = (a,b) => !g.empty(g.combine(a,b,'intersect'))
const M3 = {post: 4, hole: 1.25, clearance: 1.7, head: 3.1, head_depth: 3.3,
    hardware: 'tapped', thread: 'M3x0.5', depth: 6, access: 'bottom', min_wall: 1.5,
    screw: {diameter:3,head_diameter:5.5,head_height:3}}

// Resolve the editable plan before native CAD; incomplete cases still have a useful outline.
exports.analyze = (config, context) => {
    const {resolve, locate, shape, units} = context
    const output = {}
    for (const [id, input] of Object.entries(config.assemblies || {})) {
        if (input.preset !== 'enclosure') { continue }
        const name = `designs.assemblies.${id}`
        const findings = [], suggestions = [], placements = [], edges = []
        const issue = (path, code, message, action, severity = 'error') => findings.push({feature: `${name}.${path}`, sourcePath:`${name}.${path}`, explanation:message, repairs:[{id:'review',label:action,path:`${name}.${path}`}], code, message, action, severity})
        const record = output[id] = {findings, suggestions, placements, edges, parts: {}, parameters: input}
        try {
            const base = resolve(input.profile).model
            record.model = base
            record.bounds = m.measure.modelExtents(base)
            const dim = (key, value) => g.number(input[key] ?? value, `${name}.${key}`, units)
            const wall = dim('wall', 3), bezel = dim('bezel', 8), height = dim('height', 24)
            const floor = dim('floor', 2), plateZ = dim('plate_z', 13), fit = dim('fit', 0.5)
            const exterior = g.offset(base, bezel + wall)
            record.exterior = exterior
            // Geometry signatures survive path reordering. A changed edge requires an explicit reattachment.
            for (const path of g.paths(base)) {
                const length = m.measure.pathLength(path)
                const samples = Array.from({length: Math.max(2, Math.ceil(length / 2) + 1)}, (_, i) => i)
                const points = samples.map((_, i) => m.point.middle(path, i / (samples.length - 1)))
                const key = JSON.stringify([path.type, ...points.filter((_, i) => i === 0 || i === points.length - 1).flat().map(v => Math.round(v * 100) / 100), path.radius || 0])
                edges.push({id: key, points, length})
            }
            if (g.chains(base).length !== 1) { issue('profile', 'disconnected', 'The case boundary contains separate bodies.', 'Choose an existing outline, exclude helper points, or add a bridge.'); continue }
            if (!['tray', 'top', 'bottom', 'gasket'].includes(input.mounting)) { issue('mounting', 'mounting', 'Choose a mounting system.', 'Choose tray, top, bottom or gasket in Layout.') }
            const seam = g.number(input.seam?.z ?? plateZ, `${name}.seam.z`, units)
            if (seam <= floor || seam >= height - wall) { issue('seam.z', 'seam', 'The shell split must lie above the floor and below the top wall.', 'Adjust shell split height or shell height.') }
            record.parameters={...input,wall,floor,height,bezel,fit,plate_z:plateZ,pcb_z:dim('pcb_z',6),pcb_thickness:dim('pcb_thickness',1.6),plate:dim('plate',1.5),seam:{...input.seam,z:seam},gasket:{...input.gasket}}
            for (const [key,fallback] of Object.entries({travel_up:0.2,travel_down:0.2,travel_side:0.1})) { record.parameters.gasket[key]=g.number(input.gasket?.[key]??fallback,`${name}.gasket.${key}`,units) }
            const floating = input.mounting === 'gasket'
            if (floating && input.ledge) { issue('ledge', 'mounting-conflict', 'A rigid ledge clamps the floating plate.', 'Remove the ledge in Advanced / Manual.') }
            const movement = floating ? g.number(input.gasket?.travel_side ?? 0.1, name, units) : 0
            const exclusions = (input.cutouts || []).map(ref => resolve(ref).model)
            const components = (input.components || []).map(ref => ({model: g.offset(resolve(ref).model, movement),low:g.number(config.components[ref.split('.')[1]].height[0],name,units)}))
            const mounts = {}, gasketModels = []
            for (const [kind, table] of [['mount', input.mounts || {}], ['gasket', input.gaskets || {}]]) {
                for (const [key, definition] of Object.entries(table)) {
                    const position = locate(definition.anchor, `${name}.${key}`).p
                    const model = kind === 'gasket' ? shape(definition, name) : {paths: {circle: new m.paths.Circle(position, g.number(definition.post, name, units))}}
                    placements.push({id: key, kind, position, definition, model})
                    const field = `${kind === 'gasket' ? 'gaskets' : 'mounts'}.${key}`
                    const pcbSupport = kind==='mount' && definition.role==='pcb'
                    const blockedComponents=pcbSupport?components.filter(c=>c.low<dim('pcb_z',6)):components
                    if (!g.contains(exterior, model) || (!pcbSupport && exclusions.some(other => intersects(model, other))) || blockedComponents.some(other => intersects(model, other.model))) {
                        issue(field, 'clearance', 'This placement overlaps an opening, component, or case boundary.', 'Move it to a clear perimeter span in the 2D editor.')
                    }
                    if (kind === 'gasket') { gasketModels.push(model) }
                    else { mounts[key] = {...definition, post: g.number(definition.post, name, units), position} }
                    if (definition.placement?.edge && !edges.some(edge => edge.id === definition.placement.edge)) {
                        issue(`${kind === 'gasket' ? 'gaskets' : 'mounts'}.${key}`, 'edge-reference', 'The attached edge changed.', 'Select a new edge in the 2D editor.')
                    }
                    if (floating && kind === 'mount' && definition.role !== 'case') { issue(`mounts.${key}`, 'mounting-conflict', 'A rigid support clamps the floating assembly.', 'Remove this support or choose a rigid mounting style.') }
                }
            }
            const manualMounts = Object.fromEntries(Object.entries(mounts).filter(([,v]) => v.placement?.owner !== 'automatic'))
            const manualGaskets = Object.fromEntries(Object.entries(input.gaskets || {}).filter(([,v]) => v.placement?.owner !== 'automatic'))
            const suggestionInput = {...input, mounts:manualMounts, gaskets:manualGaskets}
            const context2d = {base, exterior: g.offset(exterior, -wall), units, name, shape, mounts:manualMounts, exclusions, components, gasketModels:Object.values(manualGaskets).map(def=>shape(def,name)), height}
            const spacing = dim('spacing', SPACING)
            if (!floating) { record.alternatives = {gaskets:suggest({...suggestionInput,suggest:{gaskets:{spacing,size:[10,6]}}},context2d)} }
            if (floating) {
                suggestions.push(...suggest({...suggestionInput, suggest: {gaskets: {spacing, size: [10, 6]}}}, context2d))
            } else if (input.mounting === 'top' || input.mounting === 'bottom') {
                suggestions.push(...suggest({...suggestionInput, suggest: {spacing, inset: 1, post: 3, hole: 1.1}}, context2d)
                    .map(item => ({...item, definition: {...item.definition, role: 'plate', depth: 4, hardware: 'plain', access: input.mounting === 'top' ? 'bottom' : 'top'}})))
            }
            const acceptedContacts = []
            // Keep each tab attached to the plate; reserve its whole pocket.
            for (let index=suggestions.length-1; index>=0; index--) {
                const item=suggestions[index]
                if (item.kind !== 'gasket') { continue }
                if (acceptedContacts.some(position=>m.measure.pointDistance(position,item.position)<spacing)) { suggestions.splice(index,1); continue }
                const angle=item.definition.anchor.rotate*Math.PI/180
                let normal=[Math.sin(angle),-Math.cos(angle)]
                const probe=item.position.map((v,i)=>v+normal[i])
                if (m.measure.isPointInsideModel(probe,base)) { normal=normal.map(v=>-v) }
                const offset=Math.max(0,item.definition.size[1]/2-TAB_ENGAGEMENT)
                item.position=item.position.map((v,i)=>v+normal[i]*offset)
                item.definition.anchor={shift:item.position,rotate:item.definition.anchor.rotate}
                item.definition.placement={offset}
                const envelope=g.offset(shape(item.definition,name),Math.max(dim('internal_radius',0),0.2+movement))
                if (!g.contains(context2d.exterior,envelope) || components.some(c=>intersects(c.model,envelope)) || exclusions.some(c=>intersects(c,envelope))) { suggestions.splice(index,1); continue }
                acceptedContacts.push(item.position)
            }
            const occupiedGaskets = [...context2d.gasketModels, ...suggestions.filter(s => s.kind === 'gasket').map(s => shape(s.definition, name))]
            const closureBase = g.offset(base, bezel + wall - M3.post + 1)
            suggestions.push(...suggest({...suggestionInput, suggest: {spacing, inset: 1, post: M3.post, hole: M3.hole}},
                {...context2d, base: closureBase, exterior, gasketModels: occupiedGaskets,
                    exclusions: [g.offset(base, fit + movement), ...occupiedGaskets.map(model => g.offset(model, Math.max(dim('internal_radius',0),fit + movement)))]})
                .map(item => ({...item, id: `case_${item.id}`, definition: {...item.definition, ...M3, role: 'case'}})))
            if (input.mounting && !suggestions.length && !placements.length) { issue('mounts', 'placement', 'No valid mounting locations fit this outline.', 'Increase the bezel or edit the boundary.') }
            if (!suggestions.some(s=>s.definition.role==='case') && !Object.values(mounts).some(m=>m.role==='case')) { issue('mounts','case-closures','No case-closing screws fit the available wall material.', 'Increase bezel width or reduce the contact count.',input.board?'error':'warning') }
            const board = context.boards?.[id]
            if (input.mounting === 'tray' && !board && !input.pcb_profile) {
                issue('board', 'pcb-source', 'PCB supports need the board outline and its mounting holes.', 'Import or select a PCB in Layout; existing designs can declare a PCB profile.', 'warning')
            }
            if (input.mounting === 'tray' && board) {
                for (const hole of board.holes) {
                    const definition = {role:'pcb',anchor:{shift:hole.position},hole:hole.diameter/2,post:Math.max(3,hole.diameter/2+1.5),depth:4,hardware:'plain',access:'top'}
                    const envelope = {paths:{post:new m.paths.Circle(hole.position,definition.post)}}
                    if (components.some(c => c.low<dim('pcb_z',6) && intersects(c.model,envelope))) { issue('board.holes','pcb-hole-clearance',`PCB hole ${hole.id} lacks clearance for its support.`, 'Choose another hole or reduce the support diameter.'); continue }
                    suggestions.push({id:`pcb_${hole.id}`,kind:'mount',position:hole.position,definition})
                }
                {
                    const proposals = suggest({...suggestionInput, suggest:{spacing,inset:5,post:3,hole:1.1}}, {...context2d, components})
                    record.holeProposals = proposals.filter(p=>require('./board-inventory').holeFits(board,p.position,2.2)).map(p=>({id:`PCB_${p.position.map(v=>Math.round(v*100)).join('_')}`,position:p.position,diameter:2.2})).filter(p=>!(input.board.rejected_holes || []).includes(p.id))
                    if (!board.holes.length) { issue('board.holes','pcb-holes','Tray mounting requires PCB support holes.', 'Review the proposed PCB holes in Hardware.') }
                }
            }
            const candidates = suggestions.filter(s => s.kind === 'gasket')
            if (floating && !candidates.length && !gasketModels.length) { issue('gaskets', 'placement', 'No gasket contacts fit between the switches and walls.', 'Increase the boundary clearance or select another edge.') }
            for (const item of suggestions) {
                let nearest = edges[0], distance = Infinity
                for (const edge of edges) {
                    const d = Math.min(...edge.points.map(point => m.measure.pointDistance(point,item.position)))
                    if (d < distance) { distance = d; nearest = edge }
                }
                item.definition.anchor = {shift:item.position, rotate:item.definition.anchor?.rotate || 0}
                item.definition.placement = {...item.definition.placement,owner:'automatic',edge:nearest?.id}
            }
            record.parts = Object.fromEntries(['bottom', 'top', 'plate', ...(input.construction === 'midframe' ? ['middle'] : [])].map(part => [part, {}]))
        } catch (error) {
            findings.push(...(error.diagnostics || [{feature: name, code: 'analysis', message: error.message}]).map(f => ({...f, severity: 'error'})))
        }
    }
    return output
}
