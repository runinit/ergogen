const g = require('./geometry')

const MOUNTING = ['tray', 'top', 'bottom', 'gasket']
const DEFAULTS = {wall: 3, floor: 2, height: 18, plate: 1.5, plate_z: 13, bezel: 4,
    fit: 0.3, typing_angle: 0, fillet: 0, chamfer: 0, pcb_thickness: 1.6, pcb_z: 6}

exports.normalize = (spec, name, units) => {
    const result = {...spec}
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
        result[key] = g.number(spec[key] ?? fallback, `${name}.${key}`, units)
        if (result[key] < 0) { g.fail(`${name}.${key}`, 'Dimension must be nonnegative') }
    }
    for (const key of ['wall', 'floor', 'height', 'plate', 'bezel', 'pcb_thickness']) {
        g.positive(result[key], `${name}.${key}`)
    }
    if (!MOUNTING.includes(spec.mounting)) { g.fail(`${name}.mounting`, 'Choose tray, top, bottom or gasket') }
    if (result.plate_z <= result.floor || result.plate_z + result.plate >= result.height) {
        g.fail(`${name}.plate_z`, 'Plate must fit between the floor and bezel')
    }
    if (result.typing_angle >= 45) { g.fail(`${name}.typing_angle`, 'Typing angle must be less than 45 degrees') }
    result.front_height = g.number(spec.front_height ?? result.height, `${name}.front_height`, units)
    if (result.front_height < result.height * Math.cos(result.typing_angle * Math.PI / 180)) {
        g.fail(`${name}.front_height`, 'Front height cannot remove the required floor thickness')
    }
    const gasket = {...spec.gasket}
    for (const [key, fallback] of Object.entries({thickness: 2, compression: 0.2, fit: 0.2,
        travel_up: 0.2, travel_down: 0.2, travel_side: 0.1})) {
        gasket[key] = g.number(gasket[key] ?? fallback, `${name}.gasket.${key}`, units)
        if (gasket[key] < 0) { g.fail(`${name}.gasket.${key}`, 'Dimension must be nonnegative') }
    }
    gasket.kind ||= 'pads'
    if (!['pads', 'sleeves'].includes(gasket.kind) || gasket.compression >= 1 || !gasket.thickness) {
        g.fail(`${name}.gasket`, 'Invalid gasket interface, thickness or compression')
    }
    gasket.compressed = gasket.thickness * (1 - gasket.compression)
    if (spec.mounting === 'gasket') {
        if (!Object.keys(spec.gaskets || {}).length) { g.fail(`${name}.gaskets`, 'Add at least one named gasket contact') }
        if (gasket.travel_down >= gasket.compressed || gasket.travel_up >= gasket.compressed) {
            g.fail(`${name}.gasket.travel`, 'Travel must leave positive gasket material before a hard stop')
        }
    }
    result.manufacturing = {}
    for (const [part, input] of Object.entries(spec.manufacturing || {})) {
        const process = {...input}
        for (const key of ['cutter', 'reach', 'drill', 'min_wall', 'nozzle', 'layer']) {
            if (process[key] !== undefined) { process[key] = g.positive(process[key], `${name}.manufacturing.${part}.${key}`, units) }
        }
        for (const key of ['stock', 'build']) {
            if (Array.isArray(process[key])) { process[key] = process[key].map(value => g.positive(value, `${name}.manufacturing.${part}.${key}`, units)) }
        }
        result.manufacturing[part] = process
    }
    result.gasket = gasket
    return result
}
