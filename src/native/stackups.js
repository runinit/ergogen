const m=require('makerjs')
const f=require('./frames')
const g=require('../designs/geometry')
const geometry=require('./geometry')

const linked = config => {
    for (const spec of Object.values(config.designs?.assemblies || {})) {
        if (!spec.stackup) { continue }
        const stack=config.designs.stackups?.[spec.stackup]
        if (!stack || stack.pcb!==spec.board?.name) { g.fail('designs.assemblies','Choose a stack belonging to this PCB','reference') }
        spec.plate=stack.plate?.thickness ?? 1.5
        spec.plate_z=`(${spec.pcb_z ?? 6}) + (${config.pcbs[stack.pcb].thickness ?? 1.6}) + (${stack.plate?.gap ?? 5.4})`
        spec.pcb_thickness=config.pcbs[stack.pcb].thickness ?? 1.6
    }
    return config
}
const inspect = (config,scene) => {
    const result={}
    for (const [id,stack] of Object.entries(config.designs?.stackups || {})) {
        const path=`designs.stackups.${id}`, number=(value)=>scene.number(value,path)
        const board=config.pcbs?.[stack.pcb]
        if (!board) { result[id]={pcb:stack.pcb,layers:{},error:'Choose an existing PCB'}; continue }
        const inverse=f.inverse(scene.boardFrame(stack.pcb).matrix)
        const thickness=number(board.thickness ?? 1.6), plate=number(stack.plate?.thickness ?? 1.5), gap=number(stack.plate?.gap ?? 5.4)
        const surfaces={'pcb.bottom':0,'pcb.top':thickness,'plate.bottom':thickness+gap,'plate.top':thickness+gap+plate}
        const assembly=Object.entries(config.designs?.assemblies || {}).find(([,item])=>item.board?.name===stack.pcb)
        if (assembly) { surfaces['case.floor']=f.transform(inverse,scene.reference(`case.${assembly[0]}.floor`).position)[2] }
        for (const item of Object.values(scene.objects).filter(item=>item.pcb===stack.pcb && item.envelopes.body?.height)) {
            const local={...item,matrix:f.multiply(inverse,item.matrix)}
            const bounds=geometry.bounds(local,item.envelopes.body)
            surfaces[`${item.id}.body.bottom`]=bounds[0][2];surfaces[`${item.id}.body.top`]=bounds[1][2]
        }
        const layers={}, occupied={}
        for (const [name,layer] of Object.entries(stack.layers || {})) {
            try {
                const stock=number(layer.thickness),compression=number(layer.compression ?? 0)
                if (stock<=0 || compression<0 || compression>=1) { throw new Error('Use positive stock thickness and compression from 0 to less than 1.') }
                const low=surfaces[layer.lower],high=surfaces[layer.upper]
                if (low===undefined || high===undefined) { throw new Error('Place the referenced component or create its case surface.') }
                const installed=stock*(1-compression),key=`${layer.lower}:${layer.upper}`,z=low+(occupied[key] || 0),remaining=high-z-installed
                occupied[key]=(occupied[key] || 0)+installed
                layers[name]={...layer,stock,installed,z,available:high-z,remaining,status:remaining < -g.EPSILON ? 'interference':'ready',output:`${stack.pcb}_${name}`}
            } catch(error) { layers[name]={...layer,status:'unresolved',message:error.message} }
        }
        result[id]={pcb:stack.pcb,plate,gap,surfaces,layers}
    }
    return result
}
// Compile nominal flat contours once; previews and DXF exports share this model.
const compile=(config,scene,outlines,report)=> {
    const generated={}
    for (const [id,stack] of Object.entries(config.designs?.stackups || {})) {
        const board=config.pcbs?.[stack.pcb]
        if (!board) { continue }
        const inverse=f.inverse(scene.boardFrame(stack.pcb).matrix)
        const assembly=Object.values(config.designs?.assemblies || {}).find(item=>item.board?.name===stack.pcb)
        for (const [name,layer] of Object.entries(stack.layers || {})) {
            const state=report[id].layers[name],path=`designs.stackups.${id}.layers.${name}`
            if (state.status!=='ready') { continue }
            try {
                const profile=layer.profile || board?.profile
                let model=outlines[profile?.replace(/^profiles\./,'')]
                if (!model) { throw new Error('Create a board outline or select a layer profile.') }
                if (layer.material==='gasket' && !layer.profile) {
                    const pads=Object.values(assembly?.gaskets || {})
                    if (!pads.length || pads.some(pad=>pad.anchor?.feature)) { throw new Error('Select a gasket profile or add contacts with named object anchors.') }
                    model=g.union(pads.map(pad=> {
                        const anchor=pad.anchor || {},parent=anchor.ref?scene.reference(anchor.ref).matrix:scene.boardFrame(stack.pcb).matrix
                        const matrix=f.multiply(parent,f.local([...(anchor.shift || [0,0]),0],anchor.rotate || 0))
                        return geometry.project({matrix,sourcePath:path},scene.envelope({size:pad.size},path),scene.boardFrame(stack.pcb).matrix)
                    }))
                }
                const inset=scene.number(layer.inset || 0,path),clearance=scene.number(layer.clearance || 0,path)
                if (inset<0 || clearance<0) { throw new Error('Inset and cutout clearance must be nonnegative.') }
                model=g.offset(model,-inset)
                const cuts=[]
                for (const item of Object.values(scene.objects).filter(item=>item.pcb===stack.pcb)) {
                    const envelope=item.envelopes.body || (item.kind==='mount'?item.envelopes.pcb:undefined)
                    if (!envelope) { continue }
                    const local={...item,matrix:f.multiply(inverse,item.matrix)}
                    const bounds=geometry.bounds(local,envelope)
                    if (item.kind!=='mount' && (bounds[1][2]<=state.z+g.EPSILON || bounds[0][2]>=state.z+state.installed-g.EPSILON)) { continue }
                    cuts.push(g.offset(geometry.project(item,envelope,scene.boardFrame(stack.pcb).matrix),clearance))
                }
                for (const ref of layer.cutouts || []) {
                    const cut=outlines[ref.replace(/^profiles\./,'')]
                    if (!cut) { throw new Error(`Missing cutout profile: ${ref}`) }
                    cuts.push(cut)
                }
                model=g.combine(model,g.union(cuts),'subtract')
                g.validate(model,path)
                if (outlines[state.output] || generated[state.output]) { throw new Error('Another output uses this layer name.') }
                generated[state.output]=model
                state.holes=g.chains(model).reduce((total,chain)=>total+(chain.contains?.length || 0),0)
                state.bounds=m.measure.modelExtents(model)
            } catch(error) { state.status='unresolved';state.message=error.message }
        }
    }
    return generated
}
// Flat sheets are reference solids; their manufacturing outputs remain nominal DXFs.
const solids=async (config,scene,outlines,report,options)=> {
    const ready=Object.values(report).flatMap(stack=>Object.values(stack.layers).filter(layer=>layer.status==='ready' && outlines[layer.output]).map(layer=>({pcb:stack.pcb,layer})))
    if (options.analysis || !ready.length) { return {} }
    const kernel=await require('../designs/solid-kernel').open(options),result={}
    try {
        for (const {pcb,layer} of ready) {
            const name=`material_${layer.output}`
            try {
                const shape=kernel.placeRigid(kernel.extrude(outlines[layer.output],layer.installed,layer.z),scene.boardFrame(pcb).matrix)
                result[name]={...await kernel.export(shape,name,'reference'),reference:true}
            } catch(error) { layer.previewError=error.message }
        }
    } finally { kernel.close() }
    return result
}
module.exports={linked,inspect,compile,solids}
