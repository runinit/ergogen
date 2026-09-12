const f = require('./frames')
const g = require('../designs/geometry')

// Physical centers and aggregate guides are references, never extra layout objects.
const center = item => {
    const envelope = item.envelopes[item.kind === 'key' ? 'keycap' : 'body'] || item.envelopes.pcb || {}
    const at = [0,0,0]
    if (envelope.polygon?.length) {
        for (const axis of [0,1]) { at[axis]=(Math.min(...envelope.polygon.map(p=>p[axis]))+Math.max(...envelope.polygon.map(p=>p[axis])))/2 }
    }
    const matrix=f.multiply(item.matrix,f.multiply(f.local(envelope.at || [0,0,0],envelope.rotate || 0),f.local(at)))
    return {...item,matrix,position:f.position(matrix),guideParent:`objects.${item.id}`}
}
const resolve = (name, config, object, cluster, number) => {
    const match=/^(columns|rows)\.([^.]+)\.([^.]+)$/.exec(name)
    if (!match) { return undefined }
    const [,kind,id,cell]=match, parent=cluster(id)
    const spec=config.layout.clusters[id]
    const arrangement=spec.arrangement || config.layout.clusters[spec.mirror?.source]?.arrangement
    const axis=kind==='columns'?0:1
    if (!arrangement?.[kind]?.includes(cell)) { g.fail(name,'Choose an existing row or column','reference') }
    const members=Object.keys(config.layout.objects || {}).map(object).filter(item=>item.cluster===id && item.kind==='key' && item.cell?.[axis]===cell)
    if (!members.length) { g.fail(name,'This row or column has no keys','reference') }
    const rotation=kind==='columns' ? number(arrangement.splay?.[cell] || 0,`${name}.splay`) : 0
    const basis=f.multiply(parent.matrix,f.local([0,0,0],rotation)), inverse=f.inverse(basis)
    const points=members.map(item=>f.transform(inverse,center(item).position))
    const midpoint=[0,1,2].map(i=>(Math.min(...points.map(p=>p[i]))+Math.max(...points.map(p=>p[i])))/2)
    const matrix=f.multiply(basis,f.local(midpoint))
    return {...parent,matrix,position:f.position(matrix),guideParent:`clusters.${id}`,members:members.map(item=>item.id)}
}
const list = (scene,config) => {
    const guides={}
    for (const item of Object.values(scene.objects).filter(item=>item.kind!=='anchor')) {
        const id=`${item.id}.center`, frame=scene.reference(id)
        guides[id]={id,label:item.label || item.id,position:frame.position,matrix:frame.matrix,pcb:item.pcb,members:[item.id],axes:['x','y']}
    }
    for (const [id,item] of Object.entries(config.layout.clusters || {})) {
        const arrangement=item.arrangement || config.layout.clusters[item.mirror?.source]?.arrangement
        for (const kind of ['columns','rows']) {
            for (const cell of arrangement?.[kind] || []) {
                const name=`${kind}.${id}.${cell}`
                try {
                    const frame=scene.reference(name)
                    const index=arrangement[kind].indexOf(cell)+1
                    guides[name]={id:name,label:`${kind==='columns'?'Column':'Row'} ${index} · ${item.label || id}`,position:frame.position,matrix:frame.matrix,pcb:scene.objects[frame.members[0]].pcb,members:frame.members,axes:[kind==='columns'?'y':'x']}
                } catch (error) {
                    if (!String(error.message).includes('has no keys')) { throw error }
                }
            }
        }
    }
    return guides
}
module.exports={center,resolve,list}
