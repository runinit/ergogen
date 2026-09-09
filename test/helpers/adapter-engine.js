// Historical fixture harness for retained geometry and footprint adapters.
// Not a supported input API; native tests use src/ergogen directly.
const u = require('../../src/utils')
const io = require('../../src/io')
const prepare = require('../../src/prepare')
const units_lib = require('../../src/units')
const points_lib = require('../../src/points')
const outlines_lib = require('../../src/outlines')
const cases_lib = require('../../src/cases')
const designs_lib = require('../../src/designs')
const pcbs_lib = require('../../src/pcbs')

const version = '5.1.0-develop'

const process = async (raw, options={}, logger=()=>{}) => {

    const prefix = 'Interpreting format: '
    let empty = true
    let [config, format] = io.interpret(raw, logger)
    let suffix = format
    let { debug = false, svg = false } = options
    // KLE conversion warrants automaticly engaging debug mode
    // as, usually, we're only interested in the points anyway
    if (format == 'KLE') {
        suffix = `${format} (Auto-debug)`
        debug = true
    }
    logger(prefix + suffix)

    logger('Preprocessing input...')
    config = prepare.unnest(config)
    config = prepare.inherit(config)
    config = prepare.parameterize(config)
    const results = {}
    if (debug) {
        results.raw = raw
        results.canonical = u.deepcopy(config)
    }

    if (config.meta && config.meta.engine) {
        logger('Checking compatibility...')
        const engine = u.semver(config.meta.engine, 'config.meta.engine')
        if (!u.satisfies(version, engine)) {
            throw new Error(`Current ergogen version (${version}) doesn\'t satisfy config's engine requirement (${config.meta.engine})!`)
        }
    }

    logger('Calculating variables...')
    const units = units_lib.parse(config)
    if (debug) {
        results.units = units
    }

    logger('Parsing points...')
    const importedBoard = Object.values(config.designs?.assemblies || {}).some(spec => spec.board?.source === 'asset')
    if (!config.points && !importedBoard) {
        throw new Error('Input does not contain a points clause!')
    }
    const points = config.points ? points_lib.parse(config.points, units) : {}
    if (!Object.keys(points).length && !importedBoard) {
        throw new Error('Input does not contain any points!')
    }
    if (debug) {
        results.points = points
        results.demo = io.twodee(points_lib.visualize(points, units), {debug, svg})
    }

    logger('Generating outlines...')
    const outlines = outlines_lib.parse(config.outlines || {}, points, units)
    let caseConfig = config.cases || {}
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
            boardSources: generated => require('../../src/designs/board-link').sources(config, {...outlines,...generated}, points, units, options.assets)})
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
    const pcbs = pcbs_lib.parse(config, points, outlines, units)
    results.pcbs = {}
    for (const [pcb_name, pcb_text] of Object.entries(pcbs)) {
        if (!debug && pcb_name.startsWith('_')) continue
        results.pcbs[pcb_name] = pcb_text
        empty = false
    }

    for (const board of Object.values(results.designs?.boards || {})) { results.pcbs[board.name.replace(/\.kicad_pcb$/, '')] = board.source }

    if (!debug && empty) {
        logger('Output would be empty, rerunning in debug mode...')
        return process(raw, {debug: true, svg}, () => {})
    }
    return results
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
        default:
            throw new Error(`Unknown injection type "${type}" with name "${name}" and value "${value}"!`)
    }
}

module.exports = {
    version,
    process,
    inject,
    footprints: require('../../src/footprint-tools')
}
