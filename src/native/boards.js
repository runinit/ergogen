const m = require('makerjs')
const g = require('../designs/geometry')
const geometry = require('./geometry')
const f = require('./frames')

const sources = (config,boards,assets) => {
    const result={}
    for (const [id,assembly] of Object.entries(config.designs?.assemblies || {})) {
        if (!assembly.board) { continue }
        const name=assembly.board.name
        if (assembly.board.source==='asset') {
            if (!assets[name]) { g.fail(`designs.assemblies.${id}.board`,'Missing PCB asset','reference') }
            const inventory=require('../designs/board-inventory')
            let source=assets[name]
            for (const [reference,models] of Object.entries(assembly.board.models || {})) { source=inventory.associate(source,reference,models) }
            for (const hole of assembly.board.holes || []) { source=inventory.addHole(source,hole) }
            result[id]={...inventory.read(source),source,name}
        } else {
            if (!boards[name]) { g.fail(`designs.assemblies.${id}.board`,'Missing native PCB','reference') }
            result[id]=boards[name]
        }
    }
    return result
}
const attach = (config,boards,context) => {
    const {resolved,features,scene}=context
    const next={...config,components:{},assemblies:{...config.assemblies}}
    const publish=(ref,model,path)=> {
        resolved[ref]={model,occupied:model,groups:[model]}
        features[ref]=g.describe(model,path)
    }
    for (const [id,input] of Object.entries(config.assemblies || {})) {
        if (input.preset!=='enclosure') { continue }
        let spec=next.assemblies[id]={...input,components:[],openings:[],cutouts:[...(input.cutouts || [])],native:true}
        spec.front_height=input.front_height ?? scene.number(input.height ?? 24,'height')*Math.cos(scene.number(input.typing_angle || 0,'typing_angle')*f.RAD)
        const board=boards[id]
        if (board?.native) {
            for (const component of board.components) {
                component.native.matrix=f.multiply(f.inverse(scene.assemblyFrame(id)),component.native.matrix)
            }
        }
        if (board) {
            const ref=`profiles.__pcb_${id}`
            publish(ref,board.model,`designs.assemblies.${id}.board`)
            spec.pcb_profile=ref
            spec.pcb_thickness=board.thickness
            if (!board.native) {
                const imported=require('../designs/board-link').attach({assemblies:{[id]:spec}}, {[id]:board}, context)
                Object.assign(next.components,imported.components)
                // Append independent case objects to the imported assembly, retaining its PCB components and cutouts.
                spec=next.assemblies[id]=imported.assemblies[id]
            }
        }
        for (const item of Object.values(scene.objects)) {
            if (item.kind==='anchor') { continue }
            const applicable=item.assembly===id || (item.pcb && item.pcb===input.board?.name) || Object.keys(config.assemblies).length===1 && !item.assembly
            if (!applicable) { continue }
            const body=item.envelopes.body
            if (body?.height) {
                const key=`native_${item.id}`, ref=`components.${key}`
                const relative=f.multiply(f.inverse(scene.assemblyFrame(id)),f.multiply(item.matrix,f.local(body.at || [0,0,0],body.rotate || 0)))
                const localItem={...item,matrix:relative}
                const bounds=geometry.bounds(localItem,{...body,at:[0,0,0],rotate:0})
                // Preserve in-plane body contours so rotated keys leave usable mounting space.
                const model=Math.abs(Math.abs(relative[10])-1)<=g.EPSILON
                    ? geometry.project(localItem,{...body,at:[0,0,0],rotate:0})
                    : m.model.moveRelative(new m.models.Rectangle(bounds[1][0]-bounds[0][0],bounds[1][1]-bounds[0][1]),bounds[0].slice(0,2))
                next.components[key]={size:body.size,radius:body.radius,height:[bounds[0][2],bounds[1][2]],anchor:{shift:[0,0]},motion:item.motion,
                    native:{matrix:relative,object:item.id,envelope:body}}
                publish(ref,model,item.sourcePath)
                spec.components.push(ref)
            }
            if (item.envelopes.service?.height) {
                const body=item.envelopes.service, key=`service_${item.id}`, ref=`components.${key}`
                const relative=f.multiply(f.inverse(scene.assemblyFrame(id)),f.multiply(item.matrix,f.local(body.at || [0,0,0],body.rotate || 0)))
                const bounds=geometry.bounds({...item,matrix:relative},{...body,at:[0,0,0],rotate:0})
                const model=m.model.moveRelative(new m.models.Rectangle(bounds[1][0]-bounds[0][0],bounds[1][1]-bounds[0][1]),bounds[0].slice(0,2))
                next.components[key]={height:[bounds[0][2],bounds[1][2]],native:{matrix:relative,envelope:body}}
                publish(ref,model,item.sourcePath)
                spec.openings.push(ref)
            }
            if (item.envelopes.plate && item.pcb && item.pcb===input.board?.name) {
                const ref=`regions.__plate_${item.id}`
                const model=geometry.project(item,item.envelopes.plate,scene.boardFrame(item.pcb).matrix)
                publish(ref,model,item.sourcePath)
                spec.cutouts.push(ref)
            }
        }
    }
    return next
}
module.exports={sources,attach}
