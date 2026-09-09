const m = require('makerjs')
const g = require('../designs/geometry')
const geometry = require('./geometry')
const f = require('./frames')
const dot = (a,b) => a.reduce((sum,v,i)=>sum+v*b[i],0)
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
const box = (item,travel={}) => {
    const body=item.envelopes.body
    const bounds=m.measure.modelExtents(geometry.shape(body))
    const matrix=f.multiply(item.matrix,f.local(body.at || [0,0,0],body.rotate || 0))
    const half=[bounds.width/2,bounds.height/2,(body.height[1]-body.height[0])/2]
    const center=[bounds.center[0],bounds.center[1],(body.height[0]+body.height[1])/2]
    const axes=[0,1,2].map(col=>[matrix[col],matrix[col+4],matrix[col+8]])
    const clearance=body.clearance || 0
    half[0]+=clearance+(travel.travel_side || 0)
    half[1]+=clearance+(travel.travel_side || 0)
    half[2]+=clearance+((travel.travel_up || 0)+(travel.travel_down || 0))/2
    center[2]+=((travel.travel_up || 0)-(travel.travel_down || 0))/2
    return {center:f.transform(matrix,center),axes,half}
}
// Separating axes avoid reporting a collision from overlapping XY projections alone.
const overlaps = (a,b) => {
    const delta=b.center.map((v,i)=>v-a.center[i])
    const axes=[...a.axes,...b.axes,...a.axes.flatMap(left=>b.axes.map(right=>cross(left,right)))]
    return axes.every(axis=> {
        const length=Math.hypot(...axis)
        if (length<g.EPSILON) { return true }
        const unit=axis.map(v=>v/length)
        const radius=shape=>shape.half.reduce((sum,v,i)=>sum+v*Math.abs(dot(unit,shape.axes[i])),0)
        return Math.abs(dot(delta,unit))<radius(a)+radius(b)-g.TOLERANCE
    })
}
const check = (config,scene) => {
    const items=Object.values(scene.objects).filter(item=>item.envelopes.body?.height)
    const findings=[]
    const issue=(item,code,message,severity='error')=>findings.push({feature:item.sourcePath,sourcePath:item.sourcePath,code,message,severity})
    const assemblyFor=item=>config.designs?.assemblies?.[item.assembly] || Object.values(config.designs?.assemblies || {}).find(spec=>spec.board?.name===item.pcb) || (Object.keys(config.designs?.assemblies || {}).length===1?Object.values(config.designs.assemblies)[0]:undefined)
    const travel=item=>item.motion==='floating'?Object.fromEntries(Object.entries({travel_up:0.2,travel_down:0.2,travel_side:0.1}).map(([key,value])=>[key,scene.number(assemblyFor(item)?.gasket?.[key] ?? value,`designs.assemblies.gasket.${key}`)])):{}
    for (const [index,item] of items.entries()) {
        const body=item.envelopes.body
        const spec=assemblyFor(item)
        if (spec && item.kind!=='key') {
            const id=item.assembly || Object.entries(config.designs.assemblies).find(([,value])=>value===spec)?.[0]
            const bounds=geometry.bounds({...item,matrix:f.multiply(f.inverse(scene.assemblyFrame(id)),item.matrix)},body)
            const height=scene.number(spec.height ?? 24,'designs.assemblies.height')
            if (bounds[1][2]+(travel(item).travel_up || 0)>height+g.TOLERANCE) {
                issue(item,'case-height',`${item.label} exceeds the declared case height. Raise the case or change its mounting position.`)
            }
        }
        for (const other of items.slice(index+1)) {
            const shared=item.motionGroup===other.motionGroup
            if (!overlaps(box(item,shared?{}:travel(item)),box(other,shared?{}:travel(other)))) { continue }
            const approximate=body.radius || body.polygon || other.envelopes.body.radius || other.envelopes.body.polygon
            issue(item,'body-overlap',`${item.label} and ${other.label}: ${approximate?'possible ':''}physical envelope overlap${shared?'':' through the declared movement range'}.`,approximate?'warning':'error')
        }
    }
    return findings
}
const boardCheck = (scene, id, board, config) => {
    const inverse=f.inverse(scene.boardFrame(id).matrix), findings=[]
    const reported = new Set(), uncertain = new Set()
    for (const pad of board.pads || []) {
        if (pad.approximate && !uncertain.has(pad.reference)) {
            uncertain.add(pad.reference)
            findings.push({feature:pad.sourcePath,sourcePath:pad.sourcePath,code:'pcb-pad-geometry',severity:'warning',
                message:`${pad.reference}: custom pad geometry needs an explicit edge-clearance check; its bounding rectangle is only an estimate.`})
        }
        if (g.contains(board.model,pad.model) || reported.has(pad.reference)) { continue }
        reported.add(pad.reference)
        findings.push({feature:pad.sourcePath,sourcePath:pad.sourcePath,code:'pcb-pad-outside',severity:pad.approximate?'warning':'error',
            message:`${pad.reference}: ${pad.approximate?'possible ':''}pad area outside PCB ${id}. Add its PCB support envelope to the boundary or move the component.`})
    }
    for (const item of Object.values(scene.objects)) {
        const body=item.envelopes.body
        if (!body?.height || item.kind==='key' || item.kind==='mount') { continue }
        const local={...item,matrix:f.multiply(inverse,item.matrix)}
        const bounds=geometry.bounds(local,body)
        const frame=scene.boardFrame(id)
        const assembly=Object.values(config.designs?.assemblies || {}).find(spec=>spec.board?.name===id)
        const moving=frame.motion==='floating' && item.motionGroup!==frame.motionGroup
        const down=moving?scene.number(assembly?.gasket?.travel_down ?? 0.2,`pcbs.${id}.travel_down`):0
        const up=moving?scene.number(assembly?.gasket?.travel_up ?? 0.2,`pcbs.${id}.travel_up`):0
        if (bounds[0][2]>=board.thickness+up-g.TOLERANCE || bounds[1][2]<=-down+g.TOLERANCE) { continue }
        const planar=Math.abs(Math.abs(local.matrix[10])-1)<g.EPSILON
        const projection=planar?geometry.project(local,body):m.model.moveRelative(new m.models.Rectangle(bounds[1][0]-bounds[0][0],bounds[1][1]-bounds[0][1]),bounds[0].slice(0,2))
        if (g.empty(g.combine(projection,board.model,'intersect'))) { continue }
        findings.push({feature:item.sourcePath,sourcePath:item.sourcePath,code:'pcb-overlap',severity:planar?'error':'warning',message:`${item.label}: ${planar?'':'possible '}body intersection with PCB ${id}. Change its mounting height or add an explicit board opening.`})
    }
    return findings
}
module.exports={check,box,overlaps,boardCheck}
