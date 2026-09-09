const m = require('makerjs')
const sexpr = require('../templates/sexpr')
const g = require('./geometry')
const children = (node, name) => node.filter(item => Array.isArray(item) && item[0] === name)
const child = (node, name) => children(node, name)[0] || []
const text = value => value ? sexpr.value(value) : ''
const nums = node => node.slice(1).map(Number)
const xy = node => [Number(node[1] || 0), -Number(node[2] || 0)]
const layer = node => text(child(node, 'layer')[1])
const rad = Math.PI / 180
const transformed = (p, at) => {
    const x = p[0], y = p[1]
    const angle = Number(at[3] || 0) * rad
    return [Number(at[1] || 0) + x * Math.cos(angle) - y * Math.sin(angle), -Number(at[2] || 0) + x * Math.sin(angle) + y * Math.cos(angle)]
}
const rectangle = (low, high) => m.model.moveRelative(new m.models.Rectangle(high[0] - low[0], high[1] - low[1]), low)
const graphics = nodes => {
    const result = {models: {}, paths: {}}
    nodes.forEach((node, i) => {
        const start = xy(child(node, 'start')), end = xy(child(node, 'end'))
        if (/_line$/.test(node[0])) { result.paths[i] = new m.paths.Line(start, end) }
        if (/_rect$/.test(node[0])) { result.models[i] = rectangle(start.map((v,j) => Math.min(v,end[j])), start.map((v,j) => Math.max(v,end[j]))) }
        if (/_circle$/.test(node[0])) { const center = xy(child(node, 'center')); result.paths[i] = new m.paths.Circle(center, m.measure.pointDistance(center,end)) }
        if (/_poly$/.test(node[0])) { result.models[i] = new m.models.ConnectTheDots(true, children(child(node,'pts'),'xy').map(xy)) }
        if (/_arc$/.test(node[0])) {
            const mid = xy(child(node, 'mid'))
            const [a,b,c] = [start,mid,end], det = 2*(a[0]*(b[1]-c[1])+b[0]*(c[1]-a[1])+c[0]*(a[1]-b[1]))
            if (Math.abs(det) < g.EPSILON) { return }
            const sq = p => p[0]*p[0]+p[1]*p[1]
            const center = [(sq(a)*(b[1]-c[1])+sq(b)*(c[1]-a[1])+sq(c)*(a[1]-b[1]))/det,
                (sq(a)*(c[0]-b[0])+sq(b)*(a[0]-c[0])+sq(c)*(b[0]-a[0]))/det]
            const angle = p => (Math.atan2(p[1]-center[1],p[0]-center[0])/rad+360)%360
            const ccw = ((angle(b)-angle(a)+360)%360) < ((angle(c)-angle(a)+360)%360)
            result.paths[i] = new m.paths.Arc(center,m.measure.pointDistance(center,a),angle(ccw?a:c),angle(ccw?c:a))
        }
    })
    return result
}

// Import mechanical data only. Keep the original source for lossless board patches.
exports.read = source => {
    const root = sexpr.parse(source, 'PCB import')[0]
    if (root?.[0] !== 'kicad_pcb') { throw new Error('Select a .kicad_pcb board file.') }
    const components = [], holes = [], obstacles = [], footprintZones = []
    const outline = root.filter(node => Array.isArray(node) && layer(node) === 'Edge.Cuts')
    if (outline.some(node => !/^gr_(line|rect|circle|poly|arc)$/.test(node[0]))) { throw new Error('Unsupported Edge.Cuts geometry. Convert board curves to arcs or line segments before importing.') }
    const model = graphics(outline)
    if (g.empty(model)) { throw new Error('The PCB has no supported Edge.Cuts outline.') }
    for (const [index, fp] of [...children(root,'footprint'), ...children(root,'module')].entries()) {
        const at = child(fp,'at'), side = layer(fp) === 'B.Cu' ? 'bottom' : 'top'
        for (const zone of children(fp,'zone')) {
            footprintZones.push(...children(zone,'polygon').map(polygon => children(child(polygon,'pts'),'xy').map(p => transformed(xy(p),at))))
        }
        const reference = text(children(fp,'property').find(p => text(p[1]) === 'Reference')?.[2]) || text(children(fp,'fp_text').find(p => p[1] === 'reference')?.[2]) || `component_${index}`
        const footprint = text(fp[1]), id = text(child(fp,'uuid')[1] || child(fp,'tstamp')[1]) || reference
        const local = graphics(fp.filter(node => Array.isArray(node) && /CrtYd$/.test(layer(node))))
        const courtyards = m.measure.modelExtents(local)
        const family = /choc.*v?2/i.test(footprint) ? 'choc-v2' : /choc/i.test(footprint) ? 'choc-v1' : /(?:switch.*mx|sw_mx)/i.test(footprint) ? 'mx' : null
        const size = courtyards ? [courtyards.width,courtyards.height] : family ? [15,15] : null
        const models = require('../footprint-tools').inspect(sexpr.print(fp)).models
        const item = {id, reference, footprint, position:xy(at), rotation:Number(at[3]||0), side, family, size, body_offset:courtyards?.center || [0,0],
            height:family === 'mx' ? [0,11.6] : family ? [0,6.5] : null, models,
            populated: !child(fp,'attr').includes('dnp') && !child(fp,'dnp').includes('yes')}
        if (!/mounting.?hole/i.test(footprint)) { components.push(item) }
        for (const pad of children(fp,'pad')) {
            const position = transformed(xy(child(pad,'at')),at,side)
            const dimensions = nums(child(pad,'size'))
            const diameter = Number(child(pad,'drill').find(v => /^\d/.test(v)) || 0)
            if (pad[2] === 'np_thru_hole' && diameter > 0 && /mounting.?hole/i.test(footprint)) { holes.push({id:`${id}_${text(pad[1])}`, position, diameter}) }
            else { obstacles.push({position, radius:Math.hypot(...dimensions)/2}) }
        }
    }
    for (const via of children(root,'via')) { obstacles.push({position:xy(child(via,'at')),radius:Number(child(via,'size')[1]||0)/2}) }
    // Unknown copper graphics prevent a positive hole-clearance claim.
    const copperGraphics = root.some(node=>Array.isArray(node)&&/^gr_/.test(node[0])&&/\.Cu$/.test(layer(node))) || children(root,'footprint').some(fp=>fp.some(node=>Array.isArray(node)&&/^fp_(line|arc|circle|rect|poly|text|text_box)$/.test(node[0])&&/\.Cu$/.test(layer(node))))
    const traces = [...children(root,'segment'), ...children(root,'arc')].map(node => ({start:xy(child(node,'start')),end:xy(child(node,'end')),width:Number(child(node,'width')[1]||0), arc:node[0]==='arc'}))
    const zones = [...footprintZones,...children(root,'zone').flatMap(zone => children(zone,'polygon').map(polygon => children(child(polygon,'pts'),'xy').map(xy)))]
    return {thickness:Number(child(child(root,'general'),'thickness')[1]||1.6), model, components, holes, obstacles, traces, zones, copperGraphics}
}
const distance = (p,a,b) => {
    const delta = [b[0]-a[0],b[1]-a[1]], norm = delta[0]**2+delta[1]**2
    const t = norm ? Math.max(0,Math.min(1,((p[0]-a[0])*delta[0]+(p[1]-a[1])*delta[1])/norm)) : 0
    return Math.hypot(p[0]-a[0]-t*delta[0],p[1]-a[1]-t*delta[1])
}
exports.holeFits = (inventory, position, diameter) => {
    if (!Number.isFinite(diameter) || diameter <= 0 || position.length !== 2 || position.some(v=>!Number.isFinite(v)) || inventory.copperGraphics) { return false }
    const radius = diameter/2 + 0.5
    if (!g.contains(inventory.model,{paths:{hole:new m.paths.Circle(position,radius)}})) { return false }
    if (inventory.obstacles.some(p => m.measure.pointDistance(p.position,position) < radius+p.radius)) { return false }
    if (inventory.traces.some(t => t.arc || distance(position,t.start,t.end) < radius+t.width/2)) { return false }
    if (inventory.zones.some(points => !g.empty(g.combine(new m.models.ConnectTheDots(true,points),{paths:{hole:new m.paths.Circle(position,radius)}},'intersect')))) { return false }
    return !inventory.holes.some(h => m.measure.pointDistance(h.position,position)<radius+h.diameter/2)
}
exports.associate = (source, id, model) => {
    return require('../footprint-tools').models(source, model, {id})
}
exports.addHole = (source, hole) => {
    const inventory = exports.read(source)
    if (!exports.holeFits(inventory,hole.position,hole.diameter)) { throw new Error('The proposed PCB hole overlaps copper, a keepout, or the board edge.') }
    const entry = `\n(footprint "MountingHole:CaseDesigner" (layer "F.Cu") (at ${hole.position[0]} ${-hole.position[1]}) (property "Reference" ${sexpr.quote(hole.id)}) (pad "" np_thru_hole circle (at 0 0) (size ${hole.diameter} ${hole.diameter}) (drill ${hole.diameter}) (layers "*.Cu" "*.Mask")))\n`
    const root=sexpr.parse(source,'PCB hole')[0], end=root.range[1]-1
    return source.slice(0,end)+entry+source.slice(end)
}
