const u = require('./utils')
const io = require('./io')
const cases_lib = require('./cases')
const designs_lib = require('./designs')
const pcbs_lib = require('./pcbs')

const gPreview = scene => {
    const geometry = require('./native/geometry')
    const models = Object.values(scene.objects).filter(item=>item.kind!=='anchor').flatMap(item=> {
        const envelope = (item.kind==='key' && item.envelopes.keycap) || item.envelopes.pcb || item.envelopes.body
        if (!envelope) { return [] }
        try { return [geometry.project(item, envelope, item.pcb ? scene.boardFrame(item.pcb).matrix : undefined)] }
        catch { return [] }
    })
    return models.length ? {models: Object.fromEntries(models.map((model,index)=>[index,model]))} : null
}

const version = require('../package.json').version

const compile = async (raw, options={}, logger=()=>{}) => {

    const native = require('./native/document').parse(raw)
    const scene = await require('./native/constraints').resolve(native,options)
    const geometry = require('./native/geometry')
    const config = native
    const {debug = false, svg = false} = options
    let empty = true
    const units = scene.units
    const points = geometry.points(scene)
    const results = {layout: geometry.serializable(scene)}
    if (debug) {
        results.raw = raw
        results.canonical = u.deepcopy(config)
        results.units = units
        results.points = points
    }
    const preview = gPreview(scene)
    if (preview) { results.demo = io.twodee(preview, {debug, svg}) }
    if (options.layoutOnly) { return results }
    const outlines = {}
    for (const spec of Object.values(config.designs?.regions || {})) {
        if (typeof spec.outline !== 'string' || Object.hasOwn(outlines, spec.outline)) { continue }
        const model = require('./outlines').resolve(spec.outline, spec, points, outlines, units)
        if (model) { outlines[spec.outline] = model }
    }
    let nativeBoards = {}
    let caseConfig = {}
    if (config.designs) {
        // Placement edits can reuse contours; every other input invalidates this worker-local cache.
        let analysisKey
        if (options.analysis && options.analysisCache) {
            const assemblies = Object.fromEntries(Object.entries(config.designs.assemblies || {}).map(([id, spec]) => {
                const stable = {...spec}
                if (spec.preset === 'enclosure') { for (const key of ['mounts', 'gaskets', 'mount_count', 'spacing']) { delete stable[key] } }
                return [id, stable]
            }))
            analysisKey = JSON.stringify([{...config, designs:{...config.designs, assemblies}}, options.assets])
        }
        const design = await designs_lib.parse(config.designs, points, outlines, units, {...options, analysisKey,
            scene, region: (spec, path) => geometry.region(scene, spec, path),
            shape: (spec,path,point) => geometry.project({matrix:require('./native/frames').local([point.x,point.y,0],point.r),sourcePath:path},scene.envelope(spec,path)),
            boardSources: generated => {
                const previousFindings = scene.findings.length
                const generatedBoards = require('./native/pcbs').compile(config, scene, {...outlines,...generated}, points)
                const findings = scene.findings.splice(previousFindings)
                const boards = require('./native/boards').sources(config, generatedBoards, options.assets || {})
                return {boards, generatedBoards, findings}
            }})
        nativeBoards = design.boardBundle?.generatedBoards || {}
        Object.assign(outlines, design.outlines)
        for (const name of Object.keys(design.cases)) {
            if (Object.prototype.hasOwnProperty.call(caseConfig, name)) {
                throw new Error(`designs.assemblies: Output-name collision: ${name}`)
            }
        }
        caseConfig = {...caseConfig, ...design.cases}
        results.designs = design.report
        if (Object.keys(design.solids).length) {
            results.solids = design.solids
            empty = false
        }
    }
    results.outlines = {}
    for (const [name, outline] of Object.entries(outlines)) {
        if (!debug && name.startsWith('_')) continue
        results.outlines[name] = io.twodee(outline, {debug, svg})
        empty = false
    }

    logger('Modeling cases...')
    const cases = cases_lib.parse(caseConfig, outlines, units)
    results.cases = {}
    for (const [case_name, case_script] of Object.entries(cases)) {
        if (!debug && case_name.startsWith('_')) continue
        results.cases[case_name] = {jscad: case_script}
        empty = false
    }

    logger('Scaffolding PCBs...')
    const pcbs = Object.fromEntries(Object.entries(nativeBoards).map(([id,board])=>[id,board.source]))
    results.pcbs = {}
    for (const [pcb_name, pcb_text] of Object.entries(pcbs)) {
        if (!debug && pcb_name.startsWith('_')) continue
        results.pcbs[pcb_name] = pcb_text
        empty = false
    }

    for (const board of Object.values(results.designs?.boards || {})) { results.pcbs[board.name.replace(/\.kicad_pcb$/, '')] = board.source }

    if (!debug && empty) {
        logger('Output would be empty, rerunning in debug mode...')
        return process(raw, {...options, debug: true, svg}, () => {})
    }
    return results
}

const process = async (raw, options={}, logger=()=>{}) => {
    try {
        const result=await compile(raw,options,logger)
        require('./native/document').locate(raw,result.layout?.findings)
        return result
    } catch (error) {
        require('./native/document').locate(raw,error.diagnostics)
        throw error
    }
}

const inject = (type, name, value) => {
    if (value === undefined) {
        value = name
        name = type
        type = 'footprint'
    }
    switch (type) {
        case 'footprint':
            return pcbs_lib.inject_footprint(name, value)
        case 'template':
            return pcbs_lib.inject_template(name, value)
        case 'outline':
            return require('./outlines').inject(name, value)
        default:
            throw new Error(`Unknown injection type "${type}" with name "${name}" and value "${value}"!`)
    }
}

module.exports = {
    version,
    process,
    inject,
    footprints: require('./footprint-tools')
}
