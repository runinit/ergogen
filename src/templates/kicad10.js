const legacy = require('./kicad8')
const sexpr = require('./sexpr')
const version = require('../../package.json').version
const FORMAT_VERSION = 20260206
const HALF_TURN = 180
const layers = [
    [0, 'F.Cu', 'signal'], [2, 'B.Cu', 'signal'],
    [9, 'F.Adhes'], [11, 'B.Adhes'], [13, 'F.Paste'], [15, 'B.Paste'],
    [5, 'F.SilkS'], [7, 'B.SilkS'], [1, 'F.Mask'], [3, 'B.Mask'],
    [17, 'Dwgs.User'], [19, 'Cmts.User'], [21, 'Eco1.User'], [23, 'Eco2.User'],
    [25, 'Edge.Cuts'], [27, 'Margin'], [31, 'F.CrtYd'], [29, 'B.CrtYd'],
    [35, 'F.Fab'], [33, 'B.Fab']
]
const child = (node, name) => node.find(item => Array.isArray(item) && item[0] === name)

// Normalize fragments at the backend boundary; footprint authors keep numeric nets.
const normalize = (node, nets, context) => {
    const kind = node[0]
    if (kind === 'net') {
        const atom = node[1]
        if (!atom) {
            throw new Error(`${context}: missing net reference`)
        }
        if (atom.startsWith('"')) {
            return node
        }
        const name = nets.get(Number(atom))
        if (name === undefined) {
            throw new Error(`${context}: unresolved net ${atom}`)
        }
        if (node[2] && sexpr.value(node[2]) !== name) {
            throw new Error(`${context}: net ${atom} name disagrees with board registry`)
        }
        return ['net', sexpr.quote(name)]
    }
    if (kind === 'module') {
        node[0] = 'footprint'
    }
    if (/^(fp|gr)_(line|arc|circle|rect|poly|curve)$/.test(kind)) {
        const width = child(node, 'width')
        if (width) {
            node.splice(node.indexOf(width), 1, ['stroke', width, ['type', 'default']])
        }
        const angle = child(node, 'angle')
        if (kind.endsWith('_arc') && angle) {
            const center = child(node, 'start')
            const start = child(node, 'end')
            const radians = Number(angle[1]) * Math.PI / HALF_TURN
            const rotate = fraction => {
                const x = Number(start[1]) - Number(center[1])
                const y = Number(start[2]) - Number(center[2])
                const theta = radians * fraction
                return [String(Number(center[1]) + x * Math.cos(theta) - y * Math.sin(theta)),
                    String(Number(center[2]) + x * Math.sin(theta) + y * Math.cos(theta))]
            }
            const end = rotate(1)
            const mid = rotate(0.5)
            center.splice(0, center.length, 'start', ...start.slice(1))
            start.splice(0, start.length, 'end', ...end)
            node.splice(node.indexOf(angle), 1)
            node.splice(node.indexOf(start), 0, ['mid', ...mid])
        }
    }
    // Legacy timestamps and zone net names are superseded by native identities.
    return node.filter(item => !Array.isArray(item) ||
        !['tstamp', 'net_name'].includes(item[0])).map(item =>
        Array.isArray(item) ? normalize(item, nets, context) : item)
}

module.exports = {
    convert_outline: legacy.convert_outline,
    body: params => {
        const nets = new Map(params.nets.map(net => [net.index, net.name]))
        const fragments = [...params.footprints, ...Object.values(params.outlines)]
        const content = fragments.flatMap((text, index) => {
            const context = `PCB ${params.name}, footprint/outline ${index + 1}`
            return sexpr.parse(text, context).map(node => sexpr.print(normalize(node, nets, context)))
        }).join('\n')
        return `(kicad_pcb (version ${FORMAT_VERSION})
(generator "ergogen") (generator_version ${sexpr.quote(version)})
(general (thickness 1.6)) (paper "A3")
(title_block (title ${sexpr.quote(params.name)}) (rev ${sexpr.quote(params.version)}) (company ${sexpr.quote(params.author)}))
(layers ${layers.map(([id, name, type = 'user']) => `(${id} ${sexpr.quote(name)} ${type})`).join('\n')})
(setup (pad_to_mask_clearance 0.05) (allow_soldermask_bridges_in_footprints no))
${content}
(embedded_fonts no))\n`
    }
}
