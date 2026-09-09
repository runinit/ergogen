const m = require('makerjs')
const g = require('./geometry')

// Find the facing boundary at the alignment line, including a collinear edge.
const edgePoint = (model, bounds, axis, edge, direction) => {
    const along = 1-axis, a = [...bounds.low], b = [...bounds.high]
    a[axis] = edge; b[axis] = edge
    const line = new m.paths.Line(a,b), candidates = []
    for (const path of g.paths(model)) {
        const ends = m.point.fromPathEnds(path) || []
        candidates.push(...ends.filter(point=>Math.abs(point[axis]-edge)<g.EPSILON))
        candidates.push(...(m.path.intersection(line,path)?.intersectionPoints || []))
    }
    return candidates.reduce((best,point)=>best===undefined || direction*(point[along]-best)>0 ? point[along] : best,undefined)
}

// Align a rectangular web to the shared edge, using feature bounds as its datum.
exports.aligned = (first, second, width, align, path) => {
    const axis = ['top','bottom'].includes(align) ? 1 : 0
    const along = 1-axis, high = ['top','right'].includes(align)
    const bounds = [first,second].map(model => m.measure.modelExtents(model))
    const edge = high ? Math.min(...bounds.map(b=>b.high[axis])) : Math.max(...bounds.map(b=>b.low[axis]))
    const center = edge+(high?-width/2:width/2)
    const ends = bounds.map((b,i) => {
        const point = [...b.center]
        const direction = Math.sign(bounds[1-i].center[along]-b.center[along])
        const candidate = edgePoint([first,second][i],b,axis,edge,direction)
        if (candidate!==undefined && direction*(candidate-point[along])<0) { point[along] = candidate }
        point[axis] = center
        return point
    })
    if (Math.abs(ends[0][along]-ends[1][along])<g.EPSILON) { g.fail(path,'Aligned bridge needs separated feature centers') }
    for (const [i,point] of ends.entries()) {
        if (!m.measure.isPointInsideModel(point,[first,second][i])) { g.fail(path,'Aligned bridge misses its feature; reduce its width or use explicit anchors') }
    }
    const corner = (point, side) => point.map((v,i)=>v+(i===axis?side*width/2:0))
    return new m.models.ConnectTheDots(true,[corner(ends[0],1),corner(ends[1],1),corner(ends[1],-1),corner(ends[0],-1)])
}
