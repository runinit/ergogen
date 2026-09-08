const g = require('./geometry')
const HEADER = 84, FACE_BYTES = 50, VERTEX_OFFSET = 12

// Convert STL triangles at the kernel boundary; sewing retains disconnected bodies.
exports.triangles = bytes => {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    const view = new DataView(data.buffer,data.byteOffset,data.byteLength)
    const count = data.length >= HEADER ? view.getUint32(80,true) : 0
    let vertices = []
    if (count && HEADER+count*FACE_BYTES === data.length) {
        for (let face=0;face<count;face++) {
            for (let i=0;i<9;i++) { vertices.push(view.getFloat32(HEADER+face*FACE_BYTES+VERTEX_OFFSET+i*4,true)) }
        }
    } else {
        const source = new TextDecoder().decode(data)
        for (const match of source.matchAll(/vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g)) { vertices.push(...match.slice(1).map(Number)) }
    }
    if (!vertices.length || vertices.length%9 || vertices.some(v=>!Number.isFinite(v))) { g.fail('designs.model','STL contains no valid triangles.','asset') }
    const triangles=[]
    for (let i=0;i<vertices.length;i+=9) { triangles.push([vertices.slice(i,i+3),vertices.slice(i+3,i+6),vertices.slice(i+6,i+9)]) }
    return triangles
}
