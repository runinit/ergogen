const g = require('../designs/geometry')
const f = require('./frames')

const own = (map,key) => Object.prototype.hasOwnProperty.call(map,key)
const KINDS = ['key','component','mount','anchor']

// Resolve nominal placement independently from the physical support's motion group.
const resolve = config => {
    const values = {}, pending = new Set()
    const number = (value,path) => {
        if (typeof value === 'number') { return g.number(value,path) }
        const symbols = String(value).match(/[A-Za-z_][A-Za-z_0-9]*/g) || []
        for (const symbol of symbols) {
            if (own(config.units || {},symbol)) { unit(symbol) }
        }
        return g.number(value,path,values)
    }
    const unit = id => {
        if (own(values,id)) { return values[id] }
        if (pending.has(id)) { g.fail(`units.${id}`,'Cyclic unit expression','cycle') }
        pending.add(id)
        values[id]=number(config.units[id],`units.${id}`)
        pending.delete(id)
        return values[id]
    }
    for (const id of Object.keys(config.units || {})) { unit(id) }
    const vector = (value,path,length=3) => (value || Array(length).fill(0)).map((v,i)=>number(v,`${path}.${i}`))
    const definitions = {...config.layout.objects}
    const objects = {}, clusters = {}, layers = {}, active = new Set(), findings = [], generated = {}
    const assemblyFor = pcb => {
        const owners=Object.entries(config.designs?.assemblies || {}).filter(([,s])=>s.board?.source==='generated' && s.board.name===pcb)
        if (owners.length>1) { g.fail(`pcbs.${pcb}`,'A native PCB can belong to only one assembly; declare separate PCB instances','ownership') }
        return owners[0]
    }
    const frame = (matrix, owner='fixed', layer='world') => ({matrix,position:f.position(matrix),motion:owner,layer,motionGroup:layer})
    const world = frame(f.identity())
    const placed = (spec={}, base=world, path='placement', support) => {
        let parent=base
        if (spec.ref) {
            try { parent=reference(spec.ref) } catch(error) { g.fail(`${path}.ref`,error.message,'reference') }
        }
        if (support && parent.layer!==support.layer) {
            // A different physical support owns Z and tilt; references retain planar placement.
            const relative=f.multiply(f.inverse(support.matrix),parent.matrix)
            parent={...support,matrix:f.multiply(support.matrix,f.local([relative[3],relative[7],0],f.yaw(relative)))}
        }
        const at=vector(spec.at,`${path}.at`)
        const override=vector(spec.override?.at,`${path}.override.at`)
        const angle=number(spec.rotate || 0,`${path}.rotate`)+number(spec.override?.rotate || 0,`${path}.override.rotate`)
        const result=frame(f.multiply(parent.matrix,f.local(at.map((v,i)=>v+override[i]),angle,number(spec.tilt || 0,`${path}.tilt`))),base.motion,base.layer)
        result.editMatrix=parent.matrix
        return result
    }
    const guarded = (key, build) => {
        if (active.has(key)) { g.fail(key,`Cyclic placement: ${[...active,key].join(' -> ')}`,'cycle') }
        active.add(key)
        try { return build() } finally { active.delete(key) }
    }
    const assemblyFrame = id => {
        const spec=config.designs?.assemblies?.[id] || {}
        const angle=number(spec.typing_angle || 0,`designs.assemblies.${id}.typing_angle`)
        const height=number(spec.height ?? 24,`designs.assemblies.${id}.height`)
        const front=number(spec.front_height ?? height*Math.cos(angle*f.RAD),`designs.assemblies.${id}.front_height`)
        return f.local([0,0,front-height*Math.cos(angle*f.RAD)],0,angle)
    }
    const boardFrame = id => {
        const spec=config.pcbs?.[id]
        if (!spec) { g.fail(`pcbs.${id}`,'Missing board datum','reference') }
        const [assemblyId,assembly]=assemblyFor(id) || []
        const base=frame(assemblyFrame(assemblyId),assembly?.mounting==='gasket'?'floating':'fixed',`pcb.${id}`)
        return placed(spec.placement || {at:[0,0,assembly?.pcb_z ?? 6]},base,`pcbs.${id}.placement`)
    }
    const surface = name => {
        if (name==='world') { return world }
        const [kind,id,face,...rest]=name.split('.')
        if (rest.length) { g.fail(name,'Unknown mounting surface','reference') }
        if (kind==='pcb' && ['top','bottom'].includes(face)) {
            const base=boardFrame(id), thickness=number(config.pcbs[id].thickness ?? 1.6,`pcbs.${id}.thickness`)
            if (thickness<=0) { g.fail(`pcbs.${id}.thickness`,'Board thickness must be positive') }
            return frame(f.multiply(base.matrix,f.local([0,0,face==='top'?thickness:0])),base.motion,base.layer)
        }
        if (['case','plate'].includes(kind)) {
            const spec=config.designs?.assemblies?.[id]
            if (!spec) { g.fail(name,'Missing assembly datum','reference') }
            let z,motion='fixed'
            if (kind==='case' && face==='floor') { z=spec.floor ?? 2 }
            else if (kind==='case' && face==='lid') { z=number(spec.height ?? 24,`${name}.height`)-number(spec.wall ?? 3,`${name}.wall`) }
            else if (kind==='plate' && ['top','bottom'].includes(face)) {
                z=number(spec.plate_z ?? 13,`${name}.plate_z`)+(face==='top'?number(spec.plate ?? 1.5,`${name}.plate`):0)
                motion=spec.mounting==='gasket'?'floating':'fixed'
            } else { g.fail(name,'Unknown assembly surface','reference') }
            return frame(f.multiply(assemblyFrame(id),f.local([0,0,number(z,name)])),motion,`${kind}.${id}`)
        }
        return reference(name)
    }
    const layer = id => {
        if (id==='world') { return world }
        if (own(layers,id)) { return layers[id] }
        const spec=config.layout.layers?.[id]
        if (!spec) { g.fail(`layout.layers.${id}`,'Missing physical layer','reference') }
        return guarded(`layout.layers.${id}`,()=> {
            const base=surface(spec.surface || 'world')
            const result=placed(spec.placement,base,`layout.layers.${id}.placement`)
            result.motionGroup=base.motionGroup
            result.layer=id
            result.motion=spec.motion || base.motion
            result.assembly=spec.assembly
            layers[id]=result
            return result
        })
    }
    const cluster = id => {
        if (own(clusters,id)) { return clusters[id] }
        const spec=config.layout.clusters?.[id]
        if (!spec) { g.fail(`layout.clusters.${id}`,'Missing cluster','reference') }
        return guarded(`layout.clusters.${id}`,()=> {
            const result=placed(spec.placement,layer(spec.layer || 'world'),`layout.clusters.${id}.placement`)
            result.id=id
            result.label=spec.label || id
            result.locked=!!spec.locked
            if (spec.mirror) {
                const original=cluster(spec.mirror.source), axis=number(spec.mirror.axis,`layout.clusters.${id}.mirror.axis`)
                result.mirrorBase=f.local([2*axis-original.position[0],original.position[1],original.position[2]],-f.yaw(original.matrix))
                Object.assign(result,placed(spec.placement,{...result,matrix:result.mirrorBase},`layout.clusters.${id}.placement`))
            }
            clusters[id]=result
            return result
        })
    }
    const envelope = (spec,path) => {
        const result={...spec}
        for (const key of ['size','height','at']) {
            if (spec[key]) { result[key]=vector(spec[key],`${path}.${key}`,key==='at'?3:2) }
        }
        for (const key of ['radius','clearance','rotate','corner_radius','corner_relief']) {
            if (spec[key]!==undefined) { result[key]=number(spec[key],`${path}.${key}`) }
        }
        if (spec.polygon) { result.polygon=spec.polygon.map((p,i)=>vector(p,`${path}.polygon.${i}`,2)) }
        if (result.size?.some(v=>v<=0) || result.radius<=0 || (result.height && result.height[1]<=result.height[0])) {
            g.fail(path,'Physical dimensions must be positive and height limits must increase','dimension')
        }
        return result
    }
    const arrangement = (spec,id) => {
        const definition=config.layout.clusters?.[spec.cluster]?.arrangement
        if (!definition || definition.type==='free') { return f.identity() }
        const path=`layout.clusters.${spec.cluster}.arrangement`
        if (definition.type==='columns') {
            const [col,row]=spec.cell || []
            const x=definition.columns?.indexOf(col), y=definition.rows?.indexOf(row)
            if (!(x>=0 && y>=0)) { g.fail(`layout.objects.${id}.cell`,'Choose a declared column and row','reference') }
            const pitch=vector(definition.pitch || [19,19],`${path}.pitch`,2)
            const stagger=number(definition.stagger?.[col] || 0,`${path}.stagger.${col}`)
            return f.local([x*pitch[0],y*pitch[1]+stagger,0],number(definition.splay?.[col] || 0,`${path}.splay.${col}`))
        }
        if (spec.index===undefined) { g.fail(`layout.objects.${id}.index`,'Arc members need an explicit index') }
        const angle=number(definition.start || 0,`${path}.start`)+spec.index*number(definition.step ?? 15,`${path}.step`)
        const radius=number(definition.radius,`${path}.radius`)
        if (radius<=0) { g.fail(path,'Arc radius must be positive') }
        return f.local([radius*Math.sin(angle*f.RAD),radius*(1-Math.cos(angle*f.RAD)),0],angle)
    }
    const object = id => {
        if (own(objects,id)) { return objects[id] }
        const spec=definitions[id], path=generated[id] || `layout.objects.${id}`
        if (!spec) { g.fail(path,'Missing object','reference') }
        return guarded(path,()=> {
            if (!KINDS.includes(spec.kind)) { g.fail(path,'Unknown object kind') }
            const part=spec.part ? config.parts?.[spec.part] : {}
            if (!part) { g.fail(`${path}.part`, 'Missing part definition','reference') }
            if (spec.kind==='anchor' && (spec.part || spec.envelopes || spec.pcb || spec.footprints)) {
                g.fail(path,'Reference anchors cannot own physical envelopes or PCB footprints')
            }
            const mount=layer(spec.layer || config.layout.clusters?.[spec.cluster]?.layer || 'world')
            const parent=spec.cluster ? cluster(spec.cluster) : mount
            const base={...parent,matrix:f.multiply(parent.matrix,generated[id]?f.identity():arrangement(spec,id))}
            const result=placed(spec.placement,base,`${path}.placement`,spec.layer || config.layout.clusters?.[spec.cluster]?.layer ? mount : undefined)
            result.layer=mount.layer
            result.motion=mount.motion
            result.motionGroup=mount.motionGroup
            const mergedEnvelopes=Object.fromEntries([...new Set([...Object.keys(part.envelopes || {}),...Object.keys(spec.envelopes || {})])].map(key=>[key,{...part.envelopes?.[key],...spec.envelopes?.[key]}]))
            const envelopes=Object.fromEntries(Object.entries(mergedEnvelopes).map(([key,value])=>[key,envelope(value,`${path}.envelopes.${key}`)]))
            const placement=spec.placement || {}
            if (placement.above && placement.below) { g.fail(`${path}.placement`,'Choose one vertical driving relationship') }
            if (placement.above || placement.below) {
                const target=reference(placement.above || placement.below)
                const relative=f.multiply(f.inverse(mount.matrix),target.matrix)
                if (Math.abs(relative[10]-1)>g.EPSILON) { g.fail(path,'Stacking surfaces must be parallel; use an explicit mounting layer') }
                const body=envelopes.body
                if (!body?.height) { g.fail(path,'Stacking requires a declared body height','dimension') }
                const gap=number(placement.gap || 0,`${path}.placement.gap`)
                if (gap<0) { g.fail(path,'Stack clearance cannot be negative','dimension') }
                const coordinates=f.transform(f.inverse(mount.matrix),result.position)
                coordinates[2]=relative[11]+(placement.above?gap-body.height[0]:-gap-body.height[1])-(body.at?.[2] || 0)+number(placement.override?.at?.[2] || 0,`${path}.placement.override.at.2`)
                const position=f.transform(mount.matrix,coordinates)
                result.matrix[3]=position[0]; result.matrix[7]=position[1]; result.matrix[11]=position[2]
                result.position=position
            }
            // Part bindings hold shared mechanics; instances override refs, nets, or placement.
            const footprints = {}
            for (const key of new Set([...Object.keys(part.footprints || {}), ...Object.keys(spec.footprints || {})])) {
                const base = part.footprints?.[key] || {}, instance = spec.footprints?.[key] || {}
                const override = typeof instance === 'string' ? {reference: instance} : instance
                const binding = {...base, ...override}
                if (!binding.what) { g.fail(`${path}.footprints.${key}`, 'Missing footprint provider; define what on the part or instance', 'reference') }
                for (const field of ['params', 'placement']) {
                    if (base[field] || override[field]) { binding[field] = {...base[field], ...override[field]} }
                }
                footprints[key] = binding
            }
            const metadata={...spec.properties}
            objects[id]={...result,id,label:spec.label || id,kind:spec.kind,part:spec.part,revision:part.revision,cluster:spec.cluster,
                pcb:spec.pcb,side:spec.side || 'top',locked:!!spec.locked || !!parent.locked,envelopes,properties:metadata,
                footprints,models:spec.models || part.models || [],sourcePath:path,assembly:mount.assembly,
                attachments:{...part.attachments,...spec.attachments},rotation:f.yaw(result.matrix)}
            if (spec.kind==='component' && !envelopes.body?.height) {
                findings.push({feature:path,sourcePath:path,code:'component-height',severity:'warning',message:`${spec.label || id}: body dimensions are unresolved; physical clearance is not validated.`})
            }
            return objects[id]
        })
    }
    const reference = name => {
        if (name==='world') { return world }
        if (name.startsWith('layers.')) { return layer(name.slice(7)) }
        if (name.startsWith('clusters.')) { return cluster(name.slice(9)) }
        if (/^(pcb|case|plate)\./.test(name)) { return surface(name) }
        const [id,...tail]=name.replace(/^objects\./,'').split('.')
        const result=object(id)
        if (!tail.length || tail[0]==='origin') { return result }
        const [key,face]=tail
        if (['top','bottom'].includes(face)) {
            const shape=result.envelopes[key]
            if (!shape?.height) { g.fail(name,'The referenced envelope has no declared height','reference') }
            const at=[...(shape.at || [0,0,0])]
            at[2]+=shape.height[face==='top'?1:0]
            return {...result,matrix:f.multiply(result.matrix,f.local(at)),position:f.transform(result.matrix,at)}
        }
        const attachment=result.attachments[key]
        if (!attachment || tail.length!==1) { g.fail(name,'Missing named attachment','reference') }
        return guarded(`attachment.${name}`,()=>placed(attachment,result,`${result.sourcePath}.attachments.${key}`))
    }
    // Mirrored identities depend on their source ID, never array position.
    for (const [id,spec] of Object.entries(config.layout.clusters || {})) {
        if (!spec.mirror) { continue }
        for (const [sourceId,item] of Object.entries(config.layout.objects || {})) {
            if (item.cluster!==spec.mirror.source) { continue }
            const nextId=`${id}__${sourceId}`
            if (own(definitions,nextId)) { g.fail(`layout.objects.${nextId}`,'Mirrored identity collision') }
            const original=object(sourceId), axis=number(spec.mirror.axis,`layout.clusters.${id}.mirror.axis`)
            const target=cluster(id)
            const override=spec.overrides?.[sourceId] || {}
            definitions[nextId]={...item,...override,cluster:id,placement:{at:f.transform(f.inverse(target.mirrorBase),[2*axis-original.position[0],original.position[1],original.position[2]]),rotate:-original.rotation-f.yaw(target.mirrorBase),...override.placement}}
            generated[nextId]=`layout.clusters.${id}.overrides.${sourceId}`
        }
    }
    for (const id of Object.keys(config.layout.layers || {})) { layer(id) }
    for (const id of Object.keys(config.layout.clusters || {})) { cluster(id) }
    for (const id of Object.keys(definitions)) { object(id) }
    const scene={objects,clusters,layers,units:values,findings,number,envelope,reference,boardFrame,assemblyFrame}
    findings.push(...require('./clearance').check(config,scene))
    return scene
}
module.exports = {resolve}
