const m = require('makerjs')
const g = require('../designs/geometry')
const f = require('./frames')
const Point = require('../point')
const renderer = require('../pcbs')
const template = require('../templates/kicad10')
const geometry = require('./geometry')

const identity = value => {
    let hash=2166136261
    for (const char of value) { hash=Math.imul(hash^char.charCodeAt(0),16777619)>>>0 }
    return hash.toString(16).padStart(8,'0')
}
const compile = (config,scene,outlines,points) => {
    const boards={}
    for (const [id,spec] of Object.entries(config.pcbs || {})) {
        if (spec.source==='asset') { continue }
        if (!spec.profile && !Object.values(scene.objects).some(item=>item.pcb===id)) { continue }
        const profile=spec.profile?.replace(/^profiles\./,'')
        const model=outlines[profile]
        if (!model) { g.fail(`pcbs.${id}.profile`,'Choose an independent named board profile','reference') }
        const nets=Object.assign(Object.create(null),{'':0}), references=new Set(), footprints=[], components=[], owners=new Map()
        const netIndex=name=>ownNet(nets,name)
        const inverse=f.inverse(scene.boardFrame(id).matrix)
        for (const item of Object.values(scene.objects).filter(item=>item.pcb===id).sort((a,b)=>a.id.localeCompare(b.id))) {
            for (const [key,binding] of Object.entries(item.footprints).sort(([a],[b])=>a.localeCompare(b))) {
                const name=`layout.objects.${item.id}.footprints.${key}`
                const delta=binding.placement || {}
                const relative=f.multiply(inverse,f.multiply(item.matrix,f.local((delta.at || [0,0,0]).map(v=>scene.number(v,name)),scene.number(delta.rotate || 0,name))))
                const at=f.position(relative), point=new Point(at[0],at[1],f.yaw(relative))
                point.meta={...item.properties,name:item.id,mirrored:false}
                const reference=binding.reference || `X${identity(`${id}/${item.id}/${key}`)}`
                if (references.has(reference)) { g.fail(name,`Duplicate PCB reference ${reference}`) }
                references.add(reference)
                owners.set(reference,name)
                const factory=renderer._footprint(points,netIndex,()=>reference,scene.units,{references:spec.references})
                const emitted=factory({what:binding.what,params:JSON.parse(JSON.stringify(binding.params || {}))},name,point)
                footprints.push(emitted)
            }
            const body=item.envelopes.body
            const matrix=f.multiply(inverse,item.matrix), position=f.position(matrix)
            components.push({id:item.id,reference:item.label,footprint:item.part || item.kind,position:position.slice(0,2),rotation:f.yaw(matrix),side:item.side,
                kind:item.kind,native:{matrix:item.matrix},family:null,size:body?.size || null,height:body?.height || null,models:item.models,populated:true})
        }
        const thickness=scene.number(spec.thickness ?? 1.6,`pcbs.${id}.thickness`)
        const source=template.body({name:id,version:config.meta?.version || 'v1',author:config.meta?.author || 'Unknown',
            nets:Object.entries(nets).map(([name,index])=>({name,index,str:`(net ${index} ${JSON.stringify(name)})`,toString(){return this.str}})),
            thickness,footprints,outlines:{board:template.convert_outline({paths:Object.fromEntries(g.paths(model).map((path,index)=>[index,path]))},'Edge.Cuts')},custom:spec.params})
        const inventory=require('../designs/board-inventory').fragments(footprints,model)
        for (const pad of inventory.pads) { pad.sourcePath = owners.get(pad.reference) || `pcbs.${id}` }
        boards[id]={...inventory,native:true,name:id,source,model,thickness,components,findings:[]}
        scene.findings.push(...require('./clearance').boardCheck(scene,id,boards[id],config))
    }
    return boards
}
const ownNet = (nets,name) => {
    if (Object.prototype.hasOwnProperty.call(nets,name)) { return nets[name] }
    const index=Object.keys(nets).length
    nets[name]=index
    return index
}
module.exports = {compile,identity}
