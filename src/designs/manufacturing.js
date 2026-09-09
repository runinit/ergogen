const {TOLERANCE} = require('./geometry')

// Findings describe declared process limits, not CAM or physical certification.
exports.check = (part, spec, geometry) => {
    const findings = []
    const issue = (code, message, severity = 'error') => findings.push({feature: part, code, message, severity})
    if (!spec?.process) {
        issue('unassessed', 'Choose a manufacturing process and confirm its dimensions.', 'warning')
        return findings
    }
    for (const key of ['stock', 'build']) {
        if (spec[key] && (!Array.isArray(spec[key]) || spec[key].length !== 3 || spec[key].some(value => !Number.isFinite(value) || value <= 0))) {
            issue('dimensions', `${key} must contain three positive dimensions.`)
            return findings
        }
    }
    const {wall, depth, width, height, holes, fillet, angle} = geometry
    if (spec.min_wall > wall) { issue('wall', 'Wall is thinner than the declared minimum.') }
    if (spec.process === 'cnc') {
        if (!(spec.cutter > 0 && spec.reach > 0) || !spec.setups?.length) {
            issue('unassessed', 'CNC requires cutter diameter, usable reach and setup directions.', 'warning')
            return findings
        }
        if (depth > spec.reach) { issue('reach', 'Pocket depth exceeds declared cutter reach.') }
        if (spec.cutter > width) { issue('access', 'Cutter cannot enter the available pocket.') }
        for (const pocket of geometry.pockets || [{radius: fillet}]) {
            if (pocket.failure) {
                findings.push({feature: `${part}.${pocket.id}`, code: 'tool-clearance', message: pocket.failure, severity: 'error'})
            } else if (pocket.radius < spec.cutter / 2 - TOLERANCE) {
                findings.push({feature: pocket.id ? `${part}.${pocket.id}` : part, code: 'radius', severity: 'error',
                    message: 'This pocket still cannot fit the cutter after automatic relief. Choose a smaller cutter or revise the pocket.'})
            }
        }
        if (!spec.setups.includes('top')) { issue('setup', 'An interior-face machining setup is required.') }
        if (holes.some(hole => hole.diameter < spec.cutter && !spec.drill)) {
            issue('drill', 'Small holes require a declared drill diameter.', 'warning')
        }
        if (holes.some(hole => hole.access === 'bottom') && !spec.setups.includes('bottom')) {
            issue('setup', 'Underside hardware pockets require a bottom setup.')
        }
        if (spec.stock && (spec.stock[0] < width || spec.stock[1] < height || spec.stock[2] < depth)) {
            issue('stock', 'Part exceeds the declared stock envelope.')
        }
        if (geometry.sideOpenings && !spec.setups.some(setup => ['left', 'right', 'front', 'back'].includes(setup))) {
            issue('side-access', 'Wall openings require a declared side setup and tool-access review.')
        }
        if (angle) { issue('fixture', 'Typing angle requires an angled fixture or a setup aligned to the mechanical stack.', 'warning') }
        issue('cam', 'Fixture, holder collisions and cutting strategy require external CAM review.', 'info')
    } else if (spec.process === 'fdm') {
        if (!(spec.nozzle > 0 && spec.layer > 0) || !spec.orientation) {
            issue('unassessed', 'FDM requires nozzle width, layer height and orientation.', 'warning')
            return findings
        }
        if (wall < spec.nozzle * 2) { issue('wall', 'Wall is narrower than two nozzle widths.') }
        if (spec.layer > spec.nozzle) { issue('layer', 'Layer height exceeds nozzle width.') }
        if (spec.build && (width > spec.build[0] || height > spec.build[1] || depth > spec.build[2])) {
            issue('build-volume', 'Part exceeds the declared printer build volume.')
        }
        if ((geometry.overhang || angle > 0) && spec.supports !== 'allowed') {
            issue('supports', 'Shelves or tilted surfaces need an orientation/support review.', 'warning')
        }
        issue('slicer', 'Check bridges, support removal and hardware access in the slicer.', 'info')
    } else {
        issue('process', `Unsupported manufacturing process ${spec.process}`)
    }
    return findings
}
