const sexpr = require('./templates/sexpr')

// This factory also travels with exported modules, keeping CLI and worker output identical.
function createTools(parse) {
    const children = (node, key) => node.filter(item => Array.isArray(item) && item[0] === key)
    const child = (node, key) => children(node, key)[0]
    const value = atom => atom?.startsWith('"') ? JSON.parse(atom) : atom
    const print = node => Array.isArray(node) ? `(${node.map(print).join(' ')})` : node
    const quote = atom => JSON.stringify(String(atom))
    const vector = (node, fallback) => node ? node.slice(1).map(Number) : fallback
    const footprints = roots => roots.flatMap(node => node[0] === 'kicad_pcb' ? footprints(node.filter(Array.isArray)) : ['footprint','module'].includes(node[0]) ? [node] : [])
    const nameOf = node => value(node[1])
    const reference = node => value(children(node,'property').find(p => value(p[1]) === 'Reference')?.[2] || children(node,'fp_text').find(p => p[1] === 'reference')?.[2])
    const known = new Set(['version','generator','generator_version','layer','at','locked','placed','descr','tags','property','path','sheetname','sheetfile','attr','tedit','tstamp','uuid','autoplace_cost90','autoplace_cost180','solder_mask_margin','solder_paste_margin','solder_paste_ratio','clearance','zone_connect','thermal_width','thermal_gap','embedded_fonts','embedded_files','private_layers','net_tie_pad_groups','fp_text','fp_text_box','fp_line','fp_rect','fp_circle','fp_arc','fp_poly','fp_curve','pad','model'])
    const unsupported = node => node.filter(Array.isArray).filter(n => n[0] === 'zone' || n[0] === 'group' || /^fp_/.test(n[0]) && !known.has(n[0]))

    const targetOf = (roots, target = {}) => {
        const all = footprints(roots)
        if (target.count !== undefined && all.length !== target.count) { throw new Error('The footprint target changed: the generator emits a different number of footprints.') }
        const candidates = all.filter((fp,index) => {
            if (target.index !== undefined && target.index !== index) { return false }
            if (target.reference && reference(fp) !== target.reference) { return false }
            if (target.name && nameOf(fp) !== target.name) { return false }
            if (target.id && value(child(fp,'uuid')?.[1] || child(fp,'tstamp')?.[1]) !== target.id && reference(fp) !== target.id) { return false }
            return true
        })
        if (candidates.length !== 1) { throw new Error('Choose an unambiguous footprint target (reference, UUID, or unique name).') }
        return candidates[0]
    }
    const modelOf = node => {
        const INCH_TO_MM = 25.4;
        const offset = child(node,'offset'), legacy = child(node,'at');
        return {path:value(node[1]),offset:vector(child(offset || legacy || [],'xyz'),[0,0,0]).map(n => n*(!offset && legacy ? INCH_TO_MM : 1)),
            scale:vector(child(child(node,'scale') || [],'xyz'),[1,1,1]), rotate:vector(child(child(node,'rotate') || [],'xyz'),[0,0,0]),
            metadata:node.filter(Array.isArray).filter(n => !['offset','at','scale','rotate'].includes(n[0])).map(print)};
    }
    const normalize = models => (Array.isArray(models) ? models : [models]).map(model => {
        if (!model || typeof model.path !== 'string' || !model.path.trim()) { throw new Error('A model needs a file path.') }
        const result = { ...model }
        for (const key of ['offset','rotate','scale']) {
            result[key] = model[key] || (key === 'scale' ? [1,1,1] : [0,0,0])
            if (result[key].length !== 3 || result[key].some(n => !Number.isFinite(n)) || key === 'scale' && result[key].some(n => n <= 0)) {
                throw new Error(`Model ${key} must contain three finite ${key === 'scale' ? 'positive ' : ''}numbers.`)
            }
        }
        return result
    })

    const inspect = (source, target) => {
        const roots = parse(source,'Footprint inspection')
        const targets = footprints(roots)
        const identities = targets.map((fp,index) => ({name:nameOf(fp),reference:reference(fp),index,count:targets.length}))
        if (targets.length !== 1 && !target) { return {targets:identities, pads:[], nets:[], models:[], graphics:[], diagnostics:[{code:'target',severity:'error',message:'Choose one emitted footprint before editing models.'}]} }
        const fp = target ? targetOf(roots,target) : targets[0]
        const pads = children(fp,'pad').map((pad,index) => ({index, number:value(pad[1]), type:pad[2], shape:pad[3],
            at:vector(child(pad,'at'),[0,0,0]), size:vector(child(pad,'size'),[0,0]), layers:(child(pad,'layers') || []).slice(1).map(value),
            drill:child(pad,'drill') ? print(child(pad,'drill')) : undefined,
            roundrect:Number(child(pad,'roundrect_rratio')?.[1] || 0),
            mechanical:pad[2] === 'np_thru_hole' || !value(pad[1])}))
        const numbers = [...new Set(pads.filter(p => !p.mechanical).map(p => p.number))]
        const used = new Set()
        const nets = numbers.map(number => {
            const base = `pad_${number.replace(/[^A-Za-z0-9_]/g,'_') || 'net'}`
            let parameter = base, suffix = 2
            while (used.has(parameter)) { parameter = `${base}_${suffix++}` }
            used.add(parameter)
            return {number,parameter,pads:pads.filter(p => !p.mechanical && p.number === number).map(p => p.index)}
        })
        const diagnostics = fp.filter(Array.isArray).filter(n => !known.has(n[0])).map(n => ({code:unsupported(fp).includes(n) ? 'unsupported-geometry' : 'metadata',
            severity:unsupported(fp).includes(n) ? 'warning' : 'info', message:`Preserved ${n[0]}.${unsupported(fp).includes(n) ? ' Placement transforms are unsupported; convert this construct in KiCad first.' : ''}`}))
        const graphics = fp.filter(n => Array.isArray(n) && /^fp_(line|rect|circle|arc|poly|curve)$/.test(n[0])).map(n => ({type:n[0].slice(3),layer:value(child(n,'layer')?.[1]),
            start:vector(child(n,'start'),[]),end:vector(child(n,'end'),[]),mid:vector(child(n,'mid'),[]),center:vector(child(n,'center'),[]),
            points:children(child(n,'pts') || [],'xy').map(p => vector(p,[]))}))
        return {name:nameOf(fp), at:vector(child(fp,'at'),[0,0,0]), side:value(child(fp,'layer')?.[1]) === 'B.Cu' ? 'B' : 'F', targets:identities, pads,nets,graphics,models:children(fp,'model').map(modelOf),diagnostics}
    }

    // Replace only model nodes; pads, nets, tracks, comments and unrelated footprints keep their bytes.
    const models = (source, bindings, target) => {
        const fp = targetOf(parse(source,'Model binding'),target)
        const entries = normalize(bindings).map(model => `(model ${quote(model.path)} (offset (xyz ${model.offset.join(' ')})) (scale (xyz ${model.scale.join(' ')})) (rotate (xyz ${model.rotate.join(' ')})) ${(model.metadata || []).join(' ')})`).join('\n')
        const previous = children(fp,'model')
        const edits = previous.map((node,index) => ({start:node.range[0],end:node.range[1],text:index === 0 ? entries : ''}))
        if (!previous.length) { edits.push({start:fp.range[1]-1,end:fp.range[1]-1,text:`\n${entries}\n`}) }
        return edits.sort((a,b) => b.start-a.start).reduce((text,edit) => text.slice(0,edit.start)+edit.text+text.slice(edit.end),source)
    }

    // Stable per-placement IDs retain the imported identity in the embedded source.
    const placedId = (original, ref) => {
        const FNV_PRIME = 16777619, FNV_OFFSET = 2166136261;
        const seed = `${original}:${ref}`;
        const hex = [0,1,2,3].map(lane => {
            let hash = FNV_OFFSET ^ lane;
            for (const char of seed) { hash = Math.imul(hash ^ char.charCodeAt(0), FNV_PRIME) >>> 0; }
            return hash.toString(16).padStart(8,'0');
        }).join('');
        return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20)}`;
    }
    const place = (source, params, mapping) => {
        const fp = targetOf(parse(source,'KiCad conversion'))
        const side = params.side || 'F'
        if (!['F','B'].includes(side)) { throw new Error('Board side must be F or B.') }
        const [x,y,r] = [params.x || 0,params.y || 0,params.r || 0]
        if (![x,y,r].every(Number.isFinite)) { throw new Error('Footprint placement must be finite.') }
        const sourceSide = value(child(fp,'layer')?.[1]) === 'B.Cu' ? 'B' : 'F'
        const flip = sourceSide !== side
        const angle = Number(child(fp,'at')?.[3] || 0)
        const unsafe = unsupported(fp)
        if (unsafe.length && (x || y || r || flip)) { throw new Error(`Unsupported transformation of ${unsafe.map(n => n[0]).join(', ')}. Convert it in KiCad first.`) }
        if (flip && children(fp,'pad').some(p => p[3] === 'trapezoid')) { throw new Error('Unsupported back-side transformation of trapezoid pads. Convert them in KiCad first.') }
        const swapLayer = atom => {
            const layer = value(atom)
            return quote(flip ? layer.replace(/^([FB])\./, (_,side) => `${side === 'F' ? 'B' : 'F'}.`) : layer)
        }
        const walk = (node, parent) => {
            if (!Array.isArray(node)) { return }
            const key = node[0]
            if (key === 'model') { return }
            if (key === 'uuid' || key === 'tstamp') { node[1] = quote(placedId(value(node[1]),params.ref || `${x},${y},${r}`)); return }
            if (flip && key === 'angle' && parent === 'fp_arc') { node[1] = String(-Number(node[1])); }
            if (['layer','layers'].includes(key)) { node.splice(1,node.length-1,...node.slice(1).map(swapLayer)); return }
            if (flip && ['at','start','end','mid','center','xy','offset'].includes(key) && Number.isFinite(Number(node[2]))) { node[2] = String(-Number(node[2])) }
            if (key === 'at' && ['pad','fp_text','fp_text_box','property'].includes(parent)) {
                const local = Number(node[3] || 0)-angle
                node[3] = String(r+(flip ? -local : local))
            }
            if (key === 'effects' && flip) {
                const justify = child(node,'justify')
                if (justify?.includes('mirror')) { justify.splice(justify.indexOf('mirror'),1) }
                else if (justify) { justify.push('mirror') }
                else { node.push(['justify','mirror']) }
            }
            for (const part of node) { if (Array.isArray(part)) { walk(part,key) } }
        }
        for (const node of fp.filter(Array.isArray)) {
            if (node[0] === 'at') { continue }
            walk(node,fp[0])
            if (node[0] === 'pad' && node[2] !== 'np_thru_hole' && value(node[1])) {
                const parameter = mapping[value(node[1])]
                const net = params[parameter]
                if (!parameter || !net || !Number.isInteger(net.index) || net.index < 0 || typeof net.name !== 'string') { throw new Error(`Map pad ${value(node[1])} to a net before generating.`) }
                for (const old of children(node,'net')) { node.splice(node.indexOf(old),1) }
                node.push(['net',String(net.index),quote(net.name)])
            }
            if (node[0] === 'property' && value(node[1]) === 'Reference' || node[0] === 'fp_text' && node[1] === 'reference') { node[2] = quote(params.ref || 'REF**') }
        }
        const at = child(fp,'at')
        if (at) { fp.splice(fp.indexOf(at),1) }
        // KiCad applies a late parent placement to children already read, rotating them twice.
        fp.splice(2,0,['at',...[x,y,r].map(String)])
        return print(fp)
    }
    return {inspect,models,place,normalize}
}

const api = createTools(sexpr.parse)
const portable = () => `(${createTools.toString()})(${sexpr.parse.toString()})`
const convert = (source, options = {}) => {
    const inspected = api.inspect(source)
    if (inspected.targets.length !== 1) { throw new Error('Select one .kicad_mod footprint per import.') }
    const mapping = Object.fromEntries(inspected.nets.map(net => [net.number, options.mapping?.[net.number] || net.parameter]))
    const reserved = new Set(['designator','side','x','y','r','rot','at','ref','ref_hide','local_net','xy','isxy','iaxy','esxy','eaxy','point'])
    for (const parameter of Object.values(mapping)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter) || reserved.has(parameter)) { throw new Error(`Invalid net parameter: ${parameter}`) }
        reserved.add(parameter)
    }
    const params = {designator:{type:'string',value:'U'},side:{type:'string',value:'F'},...Object.fromEntries(Object.values(mapping).map(name => [name,{type:'net',value:''}]))}
    const module = `// Imported KiCad geometry. Edit net parameters at each placement.\nconst footprint = ${portable()};\nmodule.exports = {\n  params: ${JSON.stringify(params,null,2)},\n  body: p => footprint.place(${JSON.stringify(source)}, p, ${JSON.stringify(mapping)})\n};\n`
    const yaml = `what: ${JSON.stringify(options.name || inspected.name)}\nparams:\n  side: F\n${Object.values(mapping).map(name => `  ${name}: GND`).join('\n')}\n`
    return {...inspected,mapping,source:module,yaml}
}
const bind = (source, bindings, target) => {
    api.normalize(bindings)
    // Run the original module unchanged, then transform its emitted S-expression.
    return `${source}\n;module.exports = ((original) => {\n  const tools = ${portable()};\n  return {...original, body: p => tools.models(original.body(p), ${JSON.stringify(bindings)}, ${JSON.stringify(target || {})})};\n})(module.exports);\n`
}
const modelPoint = (point, model) => {
    let [x,y,z] = point.map((value,index) => value*model.scale[index])
    const [rx,ry,rz] = model.rotate.map(value => -value*Math.PI/180)
    ;[y,z] = [y*Math.cos(rx)-z*Math.sin(rx),y*Math.sin(rx)+z*Math.cos(rx)]
    ;[x,z] = [x*Math.cos(ry)+z*Math.sin(ry),-x*Math.sin(ry)+z*Math.cos(ry)]
    ;[x,y] = [x*Math.cos(rz)-y*Math.sin(rz),x*Math.sin(rz)+y*Math.cos(rz)]
    return [x,y,z].map((value,index) => value+model.offset[index])
}
const envelope = (models, assets) => {
    if (!models?.length) { return null }
    const points = []
    for (const model of api.normalize(models)) {
        const path = model.asset || model.path.replace(/^\$\{KIPRJMOD\}\/models\//,'')
        const raw = assets?.[`__model_${path}.json`]
        if (!raw) { return null }
        let bounds
        try { bounds = JSON.parse(raw).bounds } catch { return null }
        if (bounds?.length !== 2 || bounds.some(point => point.length !== 3 || point.some(n => !Number.isFinite(n)))) { return null }
        for (const x of [bounds[0][0],bounds[1][0]]) {
            for (const y of [bounds[0][1],bounds[1][1]]) {
                for (const z of [bounds[0][2],bounds[1][2]]) { points.push(modelPoint([x,y,z],model)) }
            }
        }
    }
    const low = [0,1,2].map(axis => Math.min(...points.map(point => point[axis])))
    const high = [0,1,2].map(axis => Math.max(...points.map(point => point[axis])))
    return {size:[high[0]-low[0],high[1]-low[1]],height:[low[2],high[2]],body_offset:[(low[0]+high[0])/2,(low[1]+high[1])/2]}
}
// Count placement declarations with the same preprocessing and filters as PCB generation.
const countUses = (raw, alias) => {
    const config = require('./native/document').parse(raw)
    const scene = require('./native/layout').resolve(config)
    return Object.values(scene.objects).filter(item => item.pcb).reduce((count,item) =>
        count + Object.values(item.footprints).filter(binding => binding.what === alias).length, 0)
}

module.exports = {...api,convert,bind,modelPoint,envelope,countUses}
