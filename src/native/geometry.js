const m = require('makerjs')
const g = require('../designs/geometry')
const f = require('./frames')
const Point = require('../point')

const includes = (selection,value) => selection===undefined || (Array.isArray(selection)?selection:[selection]).includes(value)
const select = (scene,spec={}) => Object.values(scene.objects).filter(item =>
    includes(spec.kind,item.kind) && includes(spec.cluster,item.cluster) && includes(spec.ids,item.id) &&
    includes(spec.pcb,item.pcb) && includes(spec.layer,item.layer))
const shape = spec => {
    if (spec.polygon) { return new m.models.ConnectTheDots(true,spec.polygon) }
    if (spec.radius) { return {paths:{circle:new m.paths.Circle([0,0],spec.radius)}} }
    if (!spec.size) { g.fail('layout','A physical envelope needs size, radius or polygon','dimension') }
    const corner=spec.corner_radius || 0, relief=spec.corner_relief || 0
    if (corner<0 || corner>Math.min(...spec.size)/2) { g.fail('layout','Corner radius must fit the envelope') }
    if (relief<0 || relief>Math.min(...spec.size)/4 || (relief && corner)) { g.fail('layout','Corner relief must fit the opening and cannot be combined with rounded corners') }
    let model=m.model.center(corner ? new m.models.RoundRectangle(...spec.size,corner) : new m.models.Rectangle(...spec.size))
    // Dogbones retain the central switch edges while clearing a round cutter.
    if (relief) {
        for (const x of [-1,1]) {
            for (const y of [-1,1]) {
                const center=[x*(spec.size[0]/2-relief/Math.SQRT2+g.TOLERANCE),y*(spec.size[1]/2-relief/Math.SQRT2+g.TOLERANCE)]
                model=g.combine(model,{paths:{relief:new m.paths.Circle(center,relief)}})
            }
        }
    }
    return model
}
const project = (item,envelope,frame=f.identity()) => {
    const relative=f.multiply(f.inverse(frame),f.multiply(item.matrix,f.local(envelope.at || [0,0,0],envelope.rotate || 0)))
    if (Math.abs(Math.abs(relative[10])-1)>g.EPSILON) { g.fail(item.sourcePath,'PCB support must be parallel to its board plane') }
    let model=shape(envelope)
    model=m.model.rotate(model,f.yaw(relative),[0,0])
    model=m.model.moveRelative(model,f.position(relative).slice(0,2))
    if (envelope.clearance) { model=g.offset(model,envelope.clearance) }
    return model
}
// Wrap polygonal support envelopes per cluster, preserving the gap between clusters.
const hull = (models, path) => {
    const points = models.flatMap(model => g.paths(model).flatMap(segment => {
        if (segment.type !== 'line') { g.fail(path, 'Hull wrapping needs polygonal support envelopes; use a rectangle or polygon') }
        return [segment.origin, segment.end]
    })).sort((a,b) => a[0]-b[0] || a[1]-b[1])
    const unique = points.filter((p,i) => !i || p[0]!==points[i-1][0] || p[1]!==points[i-1][1])
    const cross = (a,b,c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
    const chain = sequence => {
        const result = []
        for (const point of sequence) {
            while (result.length > 1 && cross(result.at(-2),result.at(-1),point) <= 0) { result.pop() }
            result.push(point)
        }
        return result.slice(0,-1)
    }
    return new m.models.ConnectTheDots(true,[...chain(unique),...chain([...unique].reverse())])
}
const region = (scene,spec,path) => {
    if (!spec.select || !spec.envelope) { g.fail(path,'Choose typed objects and a named envelope') }
    const selected=select(scene,spec.select)
    if (selected.some(item=>item.kind==='anchor')) { g.fail(path,'Reference anchors cannot contribute physical geometry') }
    if (!selected.length) { g.fail(path,'The selection contains no physical objects','selection') }
    const boards=new Set(selected.map(item=>item.pcb).filter(Boolean))
    if (boards.size>1) { g.fail(path,'Select one PCB per region; separate board planes cannot be combined') }
    const groups={}
    for (const item of selected) {
        const envelope=item.envelopes[spec.envelope]
        if (!envelope) { g.fail(`${item.sourcePath}.envelopes.${spec.envelope}`,`Missing ${spec.envelope} envelope required by ${path}`,'dimension') }
        const key=item.cluster || item.id
        const frame=item.pcb?scene.boardFrame(item.pcb).matrix:f.identity()
        ;(groups[key] ||= []).push(project(item,envelope,frame))
    }
    return Object.values(groups).map(models => {
        if (spec.wrap==='hull') { return hull(models,path) }
        const model = g.union(models)
        if (spec.wrap!=='box') { return model }
        const bounds = m.measure.modelExtents(model)
        return m.model.moveRelative(new m.models.Rectangle(bounds.width,bounds.height),bounds.low)
    })
}
const points = scene => Object.fromEntries(Object.values(scene.objects).map(item=> {
    const matrix=item.pcb?f.multiply(f.inverse(scene.boardFrame(item.pcb).matrix),item.matrix):item.matrix
    const at=f.position(matrix)
    const point=new Point(at[0],at[1],f.yaw(matrix))
    point.meta={...item.properties,name:item.id,kind:item.kind,cluster:item.cluster,mirrored:false}
    return [item.id,point]
}))
const bounds = (item,envelope) => {
    const model=shape(envelope), box=m.measure.modelExtents(model), height=envelope.height || [0,0]
    const transform=f.multiply(item.matrix,f.local(envelope.at || [0,0,0],envelope.rotate || 0))
    const corners=[box.low[0],box.high[0]].flatMap(x=>[box.low[1],box.high[1]].flatMap(y=>height.map(z=>f.transform(transform,[x,y,z]))))
    return [0,1].map(side=>[0,1,2].map(axis=>(side?Math.max:Math.min)(...corners.map(p=>p[axis]))))
}
const serializable = scene => {
    const objects=Object.fromEntries(Object.entries(scene.objects).map(([id,item])=>[id,{...item,
        bounds:Object.fromEntries(Object.entries(item.envelopes).map(([name,envelope])=>[name,bounds(item,envelope)]))}]))
    return {objects,clusters:scene.clusters,layers:scene.layers,findings:scene.findings,units:scene.units,
        ...(scene.constraints?{constraints:scene.constraints}:{})}
}
module.exports = {select,shape,project,region,points,bounds,serializable}
