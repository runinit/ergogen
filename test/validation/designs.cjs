// Run from any directory: node test/validation/designs.cjs /path/to/openjscad.js /tmp/design-artifacts
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const engine = require('../../src/ergogen')
const {convert} = require(path.resolve(process.argv[2]))
const output = path.resolve(process.argv[3])
fs.mkdirSync(output, {recursive: true})

const STL_HEADER_BYTES = 80
const STL_COUNT_BYTES = 4
const STL_FACET_BYTES = 50
const STL_VECTOR_BYTES = 12
const STL_COORDINATE_BYTES = 4
const TRIANGLE_VERTICES = 3
const WELD_DECIMALS = 4

function meshStats(buffer) {
    const triangles = buffer.readUInt32LE(STL_HEADER_BYTES), edges = new Map()
    let volume = 0
    for (let i = 0; i < triangles; i++) {
        const points = Array.from({length: TRIANGLE_VERTICES}, (_, j) => Array.from({length: TRIANGLE_VERTICES}, (_, k) => buffer.readFloatLE(STL_HEADER_BYTES + STL_COUNT_BYTES + STL_FACET_BYTES * i + STL_VECTOR_BYTES + STL_VECTOR_BYTES * j + STL_COORDINATE_BYTES * k)))
        for (let j = 0; j < TRIANGLE_VERTICES; j++) {
            const edge = [points[j], points[(j + 1) % TRIANGLE_VERTICES]].map(point => point.map(value => value.toFixed(WELD_DECIMALS)).join(',')).sort().join('|')
            edges.set(edge, (edges.get(edge) || 0) + 1)
        }
        const [a, b, c] = points
        volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
    }
    const badEdges = [...edges.values()].filter(count => count !== 2).length
    assert.equal(badEdges, 0, 'Every welded mesh edge must have two triangles')
    assert(volume > 0, 'Mesh must enclose a positive volume')
    return {triangles, volume, badEdges}
}

async function main() {
    const summary = {}
    for (const preset of ['plate', 'tray', 'stacked', 'gasket']) {
        const config = {points: {zones: {key: {}}}, outlines: {edge: [{what: 'rectangle', size: [60, 40]}]}, designs: {
            regions: {edge: {outline: 'edge'}}, profiles: {pcb: {from: 'regions.edge', clearance: 2}},
            assemblies: {[preset]: {preset, profile: 'profiles.pcb', wall: 3, floor: 2, height: 10, plate: 1.5, fit: 0.3,
                mounts: {one: {anchor: {shift: [25, 15]}, hole: 1.2, post: 3, height: 5}},
                layers: {bottom: {thickness: 2}, spacer: {thickness: 6, cavity: true}, top: {thickness: 2, cavity: true}},
                gasket: {thickness: 2, compression: 0.2, fit: 0.2}, gaskets: {left: {anchor: {shift: [-31, 0]}, size: [5, 10]}}}}
        }}
        const result = await engine.process(config, {svg: true})
        fs.writeFileSync(path.join(output, `${preset}.svg`), result.outlines.pcb.svg)
        for (const [name, part] of Object.entries(result.cases)) {
            const stl = convert({source: part.jscad, format: 'stlb'})
            const buffer = Buffer.concat(stl.data.map(part => Buffer.from(part)))
            fs.writeFileSync(path.join(output, `${name}.stl`), buffer)
            summary[name] = meshStats(buffer)
        }
    }
    fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(summary, null, 2))
    console.log(summary)
}
main().catch(error => {console.error(error); process.exitCode = 1})
