const inventory = require('./board-inventory')
const g = require('./geometry')
const m = require('makerjs')
const sexpr = require('../templates/sexpr')
const families = {mx:{size:14,height:11.6,gap:5},'choc-v1':{size:13.8,height:6.5,gap:2.2},'choc-v2':{size:14,height:6.5,gap:3.6}}
const stableId = name => {
    let hash = 2166136261
    for (const char of name) { hash = Math.imul(hash ^ char.charCodeAt(0),16777619) >>> 0 }
    return '00000000-0000-4000-8000-'+hash.toString(16).padStart(12,'0')
}
const isSwitch = point => {
    const tags = Array.isArray(point.meta.tags) ? point.meta.tags : Object.keys(point.meta.tags || {})
    return !point.meta.skip && !point.meta.helper && !/helper|mount|controller|mcu|connector|display/.test(tags.join(' '))
}
const layoutBoard = (spec, outlines, points, units) => {
    const outline = spec.profile.replace(/^profiles\./,'')
    const pcb = {outlines:{board:{outline}},template:'kicad10'}
    let source = require('../pcbs').parse({pcbs:{layout:pcb}},points,outlines,units).layout
    const family = families[spec.board.family]
    const selected = require('../filter').parse(spec.board.where ?? true, 'board.where', points, units, 'source').filter(isSwitch)
    const entries = selected.map((point,index) => `(footprint ${sexpr.quote(family ? 'CaseDesigner:Switch_'+spec.board.family : 'CaseDesigner:Unresolved_switch')} (layer "F.Cu") (at ${point.x} ${-point.y} ${point.r}) (uuid ${sexpr.quote(stableId(point.meta.name))}) (property "Reference" "SW${index+1}") (attr exclude_from_bom))`).join('\n')
    source=source.slice(0,source.lastIndexOf(')'))+entries+'\n)'
    return source
}

// The linker owns mechanical associations; PCB pads and routing remain in the original board.
exports.sources = (config, outlines, points, units, assets = {}) => {
    const boards = {}
    for (const [id, spec] of Object.entries(config.designs?.assemblies || {})) {
        if (!spec.board) { continue }
        let source
        if (spec.board.source === 'layout') {
            source = layoutBoard(spec,outlines,points,units)
        } else if (spec.board.source === 'asset') {
            source = assets[spec.board.name]
            if (!source) { throw new Error(`Missing PCB asset ${spec.board.name}. Import its project ZIP or board file.`) }
        } else {
            const pcb = config.pcbs?.[spec.board.name]
            if (!pcb) { throw new Error(`Missing PCB ${spec.board.name}. Choose an available board.`) }
            const cycle=Object.values(pcb.outlines || {}).map(outline=>outline.outline).find(outline=>outline===`${id}_plate`)
            if (cycle && !outlines[cycle]) { g.fail(`designs.assemblies.${id}.board`,`Dependency cycle: board ${spec.board.name} -> outline ${cycle} -> assembly ${id} -> board ${spec.board.name}. Use an independent PCB boundary.`,'dependency-cycle') }

            try { source = require('../pcbs').parse({...config, pcbs:{[spec.board.name]:pcb}},points,outlines,units)[spec.board.name] }
            catch (error) { throw new Error(`Board ${spec.board.name} cannot be resolved before the enclosure. Check board/assembly outline dependencies: ${error.message}`) }
        }
        for (const [ref, model] of Object.entries(spec.board.models || {})) {
            source = inventory.associate(source,ref,model)
        }
        for (const hole of spec.board.holes || []) { source = inventory.addHole(source,hole) }
        boards[id] = {...inventory.read(source), source, name: spec.board.name}
    }
    return boards
}
exports.attach = (config, boards, context) => {
    const {resolved, features, units, shape} = context
    const next = {...config, assemblies:{...config.assemblies}, components:{...config.components}}
    for (const [id, board] of Object.entries(boards)) {
        const input = config.assemblies[id]
        const s = next.assemblies[id] = {...input, components:[...(input.components || [])]}
        const ref = `profiles.__pcb_${id}`
        resolved[ref] = {model:board.model, occupied:board.model, groups:[board.model]}
        features[ref] = g.describe(board.model,`designs.assemblies.${id}.board`)
        s.pcb_profile = ref
        if (input.board.source === 'asset') { s.profile = ref }
        s.pcb_thickness = board.thickness
        const switchFamilies = [...new Set(board.components.filter(c=>c.populated&&c.family).map(c=>c.family))]
        const family = switchFamilies.length === 1 ? families[switchFamilies[0]] : null
        s.pcb_z = input.pcb_z ?? (family ? g.number(input.plate_z ?? 13,`${id}.plate_z`,units)-family.gap-board.thickness : 6)
        const pcbZ = g.number(s.pcb_z,`${id}.pcb_z`,units)
        if (shape && input.board.switch_cutouts !== false) {
            const cutouts = board.components.filter(c=>c.populated&&c.family).map(c=>shape({size:families[c.family].size,corner_relief:input.board.corner_relief ?? 0.5,anchor:{shift:c.position,rotate:c.rotation}},`${id}.switches`))
            s.cutouts=(input.cutouts || []).filter(ref=>ref!==`regions.${id}_switches`)
            if (cutouts.length) {
                const switchRef=`regions.__switches_${id}`, model=g.union(cutouts)
                resolved[switchRef]={model,occupied:model,groups:cutouts}
                features[switchRef]=g.describe(model,`${id}.board.switches`)
                s.cutouts=[switchRef,...s.cutouts]
            }
        }
        s.openings = [...(s.openings || [])]
        const unresolved = []
        for (const component of board.components) {
            if (!component.populated) { continue }
            const override = input.board.components?.[component.id] || {}
            const rawSize = override.size || component.size, rawHeight = override.height || component.height
            let size, height
            try {
                if (rawSize?.length===2 && rawHeight?.length===2) {
                    const path=`designs.assemblies.${id}.board.components.${component.id}`
                    size=rawSize.map(value=>g.positive(value,`${path}.size`,units))
                    height=rawHeight.map(value=>g.number(value,`${path}.height`,units))
                    if (height[1]<=height[0]) { height=null }
                }
            } catch { size=null; height=null }
            if (!size || !height) { unresolved.push({feature:`designs.assemblies.${id}.board.components.${component.id}`,code:'component-height',severity:'error',message:`${component.reference}: missing body size or height.`,action:'Import a model or enter the measured envelope in Components.'}); continue }
            const key = `board_${id}_${component.id.replace(/[^A-Za-z0-9_]/g,'_')}`
            const low = component.side === 'top' ? pcbZ+board.thickness+height[0] : pcbZ-height[1]
            const high = component.side === 'top' ? pcbZ+board.thickness+height[1] : pcbZ-height[0]
            const offset = override.body_offset ? [override.body_offset[0],component.side==='bottom'?-override.body_offset[1]:override.body_offset[1]] : component.body_offset || [0,0], angle = component.rotation*Math.PI/180
            const position = [component.position[0]+offset[0]*Math.cos(angle)-offset[1]*Math.sin(angle),component.position[1]+offset[0]*Math.sin(angle)+offset[1]*Math.cos(angle)]
            const def = {anchor:{shift:position,rotate:component.rotation},size,height:[low,high], motion:s.mounting==='gasket'?'floating':'fixed', ...override}
            // Envelope heights are relative to the PCB, not an override of world coordinates.
            def.height=[low,high]
            def.size=size
            next.components[key] = def
            const model = m.model.moveRelative(m.model.rotate(m.model.center(new m.models.Rectangle(...size)),component.rotation,[0,0]),position)
            resolved[`components.${key}`] = {model,occupied:model,groups:[model]}
            features[`components.${key}`] = g.describe(model,`designs.assemblies.${id}.board.components.${component.id}`)
            s.components.push(`components.${key}`)
            if (override.opening) { s.openings.push(`components.${key}`) }
            if (component.family && input.board.keycaps) {
                const path=`designs.assemblies.${id}.board.keycaps`, cap=input.board.keycaps
                try {
                    if (cap.size?.length!==2 || cap.height?.length!==2) { throw new Error('Enter width, length and both height limits.') }
                    const capSize=cap.size.map(value=>g.positive(value,`${path}.size`,units))
                    const capHeight=cap.height.map(value=>g.number(value,`${path}.height`,units))
                    if (capHeight[1]<=capHeight[0]) { throw new Error('Keycap top must be above its bottom.') }
                    const plateTop=g.number(s.plate_z ?? 13,`${path}.datum`,units)+g.number(s.plate ?? 1.5,`${path}.datum`,units)
                    const capKey=`${key}_keycap`, capModel=m.model.moveRelative(m.model.rotate(m.model.center(new m.models.Rectangle(...capSize)),component.rotation,[0,0]),component.position)
                    next.components[capKey]={anchor:{shift:component.position,rotate:component.rotation},size:capSize,height:capHeight.map(value=>value+plateTop),motion:def.motion}
                    resolved[`components.${capKey}`]={model:capModel,occupied:capModel,groups:[capModel]}
                    features[`components.${capKey}`]=g.describe(capModel,path)
                    s.components.push(`components.${capKey}`)
                } catch(error) { unresolved.push({feature:path,code:'keycaps',severity:'error',message:`Keycap clearance: ${error.message}`,action:'Enter measured keycap dimensions in Components.'}) }
            }
        }
        if (input.board.source === 'layout' && !families[input.board.family]) {
            unresolved.push({feature:`designs.assemblies.${id}.board.family`,code:'switch-family',severity:'error',message:'Choose the switch family for the layout reference board.',action:'Choose MX, Choc v1, or Choc v2 in Layout.'})
        }
        for (const [ref,association] of Object.entries(input.board.models || {})) {
            if (association.asset && !context.assets?.[association.asset]) { unresolved.push({feature:`designs.assemblies.${id}.board.models.${ref}`,code:'missing-asset',severity:'error',message:`Missing model asset ${association.asset}.`,action:'Import the model or reopen the packaged project.'}) }
        }
        if (board.components.some(c=>c.populated&&c.family) && !input.board.keycaps) {
            unresolved.push({feature:`designs.assemblies.${id}.board.keycaps`,code:'keycaps',severity:'warning',message:'Keycap dimensions are unresolved; keycap clearance has not been validated.',action:'Enter the measured keycap envelope in Components.'})
        }
        board.tolerances={outline:0.2,thickness:board.thickness>=1?board.thickness*0.1:0.1,source:'https://jlcpcb.com/capabilities/pcb-capabilities'}
        board.findings=unresolved.map(f=>({...f,sourcePath:f.feature,explanation:f.message,repairs:[{id:'review',label:f.action,path:f.feature}]}))
    }
    return next
}
