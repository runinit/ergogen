const m = require('makerjs')
const g = require('./geometry')

const MESH_TOLERANCE = 0.01
let initialized

// Keep WASM and native handles behind one adapter shared by Node and workers.
exports.open = async (options = {}) => {
    if (!initialized) {
        initialized = (async () => {
            const r = await import('replicad')
            const init = options.loadCad || (() => import('replicad-opencascadejs'))
            const {default: load} = await init()
            const oc = await load(options.cadWasm ? {locateFile: () => options.cadWasm} : {})
            r.setOC(oc)
            return {r, oc}
        })().catch(error => { initialized = undefined; throw error })
    }
    const {r, oc} = await initialized
    const owned = new Set()
    const keep = value => { owned.add(value); return value }
    const vector = p => [p[0], p[1], 0]
    const wire = chain => {
        const segments = chain.links.map(link => {
            const path = m.path.moveRelative(g.clone(link.walkedPath.pathContext), link.walkedPath.offset)
            if (path.type === 'circle') { return {path} }
            let [start, end] = m.point.fromPathEnds(path)
            if (link.reversed) { [start, end] = [end, start] }
            return {path, start, end}
        })
        const edges = segments.map(({path, start, end}, index) => {
            if (path.type === 'circle') { return keep(r.makeCircle(path.radius, vector(path.origin))) }
            // MakerJS rounds endpoints more coarsely than the solid kernel.
            const next = segments[(index + 1) % segments.length].start
            if (!next || m.measure.pointDistance(end, next) > g.TOLERANCE) {
                g.fail('designs.solid', 'Disconnected contour edges')
            }
            end = next
            if (path.type === 'arc') {
                return keep(r.makeThreePointArc(vector(start), vector(m.point.middle(path)), vector(end)))
            }
            if (path.type !== 'line') { g.fail('designs', `Unsupported solid edge ${path.type}`) }
            return keep(r.makeLine(vector(start), vector(end)))
        })
        return keep(r.assembleWire(edges))
    }
    const extrudeChain = (chain, height) => {
        const sketch = keep(new r.Sketch(wire(chain)))
        let result = keep(sketch.extrude(height))
        for (const child of chain.contains || []) {
            result = keep(result.cut(extrudeChain(child, height)))
        }
        return result
    }
    const extrude = (model, height, z = 0) => {
        g.validate(model, 'designs.solid')
        const chains = m.model.findChains(model, {contain: true})
        const solids = chains.map(chain => extrudeChain(chain, height))
        let result = solids[0]
        for (const next of solids.slice(1)) { result = keep(result.fuse(next)) }
        return z ? keep(result.translateZ(z)) : result
    }
    const bounds = shape => {
        const box = shape.boundingBox
        try { return box.bounds } finally { box.delete() }
    }
    const validate = shape => {
        const check = new oc.BRepCheck_Analyzer(shape.wrapped)
        try {
            if (!check.IsValid(shape.wrapped) || !(r.measureVolume(shape) > g.EPSILON)) {
                g.fail('designs.solid', 'Expected a valid positive-volume solid')
            }
        } finally { check.delete() }
    }
    const meshSolid = triangles => {
        const faces=triangles.map(points=>keep(r.makePolygon(points)))
        const welded=keep(r.weldShellsAndFaces(faces,true))
        const shells=[...r.iterTopo(welded.wrapped,'shell')].map(shell=>keep(r.cast(shell)))
        if (!shells.length) { g.fail('designs.model','Mesh must contain a closed shell for STEP export.','asset') }
        const solids=shells.map(shell=>keep(r.makeSolid([shell])))
        return solids.length===1?solids[0]:keep(r.makeCompound(solids))
    }
    return {
        extrude,
        compound: shapes => shapes.length === 1 ? shapes[0] : keep(r.makeCompound(shapes)),
        add: (left, right) => keep(left.fuse(right)),
        cut: (left, right) => keep(left.cut(right)),
        intersect: (left, right) => keep(left.intersect(right)),
        move: (shape, offset) => keep(shape.clone().translate(offset)),
        rotate: (shape, angle, origin = [0, 0, 0]) => keep(shape.clone().rotate(angle, origin, [1, 0, 0])),
        placeRigid: (shape, matrix) => {
            const cosine=Math.max(-1,Math.min(1,(matrix[0]+matrix[5]+matrix[10]-1)/2))
            const angle=Math.acos(cosine)
            let result=keep(shape.clone())
            if (angle>g.EPSILON) {
                let axis=[matrix[9]-matrix[6],matrix[2]-matrix[8],matrix[4]-matrix[1]]
                if (Math.hypot(...axis)<g.EPSILON) {
                    const diagonal=[matrix[0],matrix[5],matrix[10]]
                    const largest=diagonal.indexOf(Math.max(...diagonal))
                    axis=[0,0,0]
                    axis[largest]=Math.sqrt((diagonal[largest]+1)/2)
                    for (let i=0;i<3;i++) {
                        if (i!==largest) { axis[i]=(matrix[largest*4+i]+matrix[i*4+largest])/(4*axis[largest]) }
                    }
                }
                result=keep(result.rotate(angle*180/Math.PI,[0,0,0],axis))
            }
            return keep(result.translate([matrix[3],matrix[7],matrix[11]]))
        },
        fillet: (shape, radius, z) => keep(shape.fillet(radius, edges => edges.inPlane('XY', z))),
        chamfer: (shape, distance, z) => keep(shape.chamfer(distance, edges => edges.inPlane('XY', z))),
        volume: shape => Math.abs(r.measureVolume(shape)),
        bounds,
        validate,
        export: async (shape, name, role = 'manufactured') => {
            validate(shape)
            const solids = shape.solids
            try {
                if (role === 'manufactured' && solids.length !== 1) { g.fail(`designs.solid.${name}`, 'A manufactured part must contain one connected solid') }
            } finally { solids.forEach(solid => solid.delete()) }
            return {name, volume: Math.abs(r.measureVolume(shape)), bounds: bounds(shape),
                step: await shape.blobSTEP().text(),
                stl: new Uint8Array(await shape.blobSTL({binary: true, tolerance: MESH_TOLERANCE}).arrayBuffer())}
        },
        assembly: async parts => (await r.exportSTEP(Object.entries(parts).map(([name, shape]) => ({name, shape})), {unit: 'MM', modelUnit: 'MM'})).text(),
        import: async step => keep(await r.importSTEP(new Blob([step]))),
        importMesh: async bytes => meshSolid(require('./mesh-import').triangles(bytes)),
        placeModel: (input, transform, component, z) => {
            const scales = transform.scale || [1,1,1]
            if (scales.length !== 3 || scales.some(v=>!Number.isFinite(v) || v<=0)) { g.fail('designs.components','Model scales must contain three positive numbers.','asset') }
            let result
            if (scales.every(v => v === scales[0])) { result = keep(input.clone().scale(scales[0], [0,0,0])) }
            else {
                // Preserve the original STEP asset; only its assembly reference is faceted for an affine scale.
                const mesh=input.mesh({tolerance:MESH_TOLERANCE/Math.max(...scales)})
                const triangles=[]
                for (let i=0;i<mesh.triangles.length;i+=3) {
                    triangles.push(mesh.triangles.slice(i,i+3).map(index=>mesh.vertices.slice(index*3,index*3+3).map((v,axis)=>v*scales[axis])))
                }
                result=meshSolid(triangles)
            }
            for (let axis=0;axis<3;axis++) {
                const direction=[0,0,0]; direction[axis]=1
                result=keep(result.rotate(-(transform.rotate?.[axis] || 0),[0,0,0],direction))
            }
            result=keep(result.translate(transform.offset || [0,0,0]))
            if (component.side === 'bottom') { result=keep(result.rotate(180,[0,0,0],[1,0,0])) }
            result=keep(result.rotate(component.rotation,[0,0,0],[0,0,1]))
            return keep(result.translate([component.position[0],component.position[1],z]))
        },
        retained: () => owned.size,
        close: () => {
            for (const value of [...owned].reverse()) {
                try { value.delete?.() } catch { /* Some operations consume their input wrapper. */ }
            }
            owned.clear()
        }
    }
}
