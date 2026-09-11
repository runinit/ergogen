const m = require('makerjs')
const g = require('./geometry')
const MAX_BEVEL_SWEEP = 90 // Keep tangent intersections finite for large arcs.

const cross = (a,b) => a[0]*b[1]-a[1]*b[0]
const subtract = (a,b) => a.map((v,i)=>v-b[i])
const flat = model => ({paths:Object.fromEntries(g.paths(model).map((path,i)=>[i,path]))})
const ends = link => link.reversed ? [...link.endPoints].reverse() : link.endPoints
const distance = m.measure.pointDistance
const intersection = (first,last) => {
    const [a,b]=ends(first), [c,d]=ends(last)
    const v=subtract(b,a), w=subtract(d,c), divisor=cross(v,w)
    if (Math.abs(divisor) < g.EPSILON) {
        if (Math.abs(cross(subtract(c,a),v))/distance(a,b)>g.TOLERANCE) { return null }
        return b.map((value,i)=>(value+c[i])/2)
    }
    const t=cross(subtract(c,a),w)/divisor
    return a.map((value,i)=>value+t*v[i])
}
const tangent = (line,arc,point) => {
    const direction=subtract(line.end,line.origin), radial=subtract(point,arc.origin)
    return Math.abs(direction.reduce((sum,v,i)=>sum+v*radial[i],0))/distance(line.origin,line.end)<g.TOLERANCE
}
const validArc = (first,connector,last) => {
    if (connector.length!==1 || connector[0].walkedPath.pathContext.type!=='arc') { return false }
    const arc=connector[0].walkedPath.pathContext
    return tangent(first.walkedPath.pathContext,arc,ends(first)[1]) && tangent(last.walkedPath.pathContext,arc,ends(last)[0])
}
const replace = (model,first,connector,last,limit) => {
    if (validArc(first,connector,last)) { return null }
    const hit=intersection(first,last)
    if (!hit || distance(hit,ends(first)[1])>limit || distance(hit,ends(last)[0])>limit) { return null }
    // Keep both retained edges pointing forward; never create a spike or reverse an edge.
    const candidate=g.clone(model)
    candidate.paths[first.walkedPath.pathId][first.reversed?'origin':'end']=hit
    candidate.paths[last.walkedPath.pathId][last.reversed?'end':'origin']=hit
    for (const link of [first,last]) {
        const [start,end]=ends(link)
        const before=subtract(end,start)
        const path=candidate.paths[link.walkedPath.pathId]
        const after=link.reversed?subtract(path.origin,path.end):subtract(path.end,path.origin)
        if (before.reduce((sum,v,i)=>sum+v*after[i],0)<=g.EPSILON) { return null }
    }
    for (const link of connector) { delete candidate.paths[link.walkedPath.pathId] }
    try {
        g.validate(candidate,'designs')
        return g.contains(candidate,model)?candidate:null
    } catch (error) {
        if (!(error instanceof g.DesignError)) { throw error }
        return null
    }
}
const simplify = (source,limit) => {
    if (!limit) { return source }
    let model=flat(source)
    m.model.simplify(model)
    // Each accepted change removes paths, so the search terminates without a pass limit.
    for (;;) {
        let replacement
        for (const chain of g.chains(model)) {
            const links=chain.links
            for (let i=0;i<links.length && !replacement;i++) {
                const first=links[i]
                if (first.walkedPath.pathContext.type!=='line' || first.pathLength<=limit) { continue }
                const connector=[]
                let length=0
                for (let step=1;step<links.length;step++) {
                    const next=links[(i+step)%links.length]
                    if (next.walkedPath.pathContext.type==='line' && next.pathLength>limit) {
                        if (connector.length) { replacement=replace(model,first,connector,next,limit) }
                        break
                    }
                    length+=next.pathLength
                    if (length>limit) { break }
                    connector.push(next)
                }
            }
            if (replacement) { break }
        }
        if (!replacement) { return model }
        model=replacement
        m.model.simplify(model)
    }
}
const topology = model => {
    const count = chains => chains.reduce((total,chain)=>total+1+count(chain.contains || []),0)
    const chains=g.chains(model)
    return [chains.length,count(chains)]
}
const direction = (link,point) => {
    const path=link.walkedPath.pathContext
    if (path.type==='line') {
        const [a,b]=ends(link)
        return subtract(b,a).map(v=>v/distance(a,b))
    }
    const radial=subtract(point,path.origin), sign=link.reversed?-1:1
    return [-radial[1],radial[0]].map(v=>v*sign/path.radius)
}
const winding = chain => {
    const points=chain.links.flatMap(link=> {
        const samples=m.path.toPoints(link.walkedPath.pathContext,3)
        return link.reversed?samples.reverse():samples
    })
    return Math.sign(points.reduce((sum,point,i)=>sum+cross(point,points[(i+1)%points.length]),0))
}
const concaveArc = (link,orientation) => link.walkedPath.pathContext.type==='arc' && (link.reversed?-1:1)*orientation<0
const checkFillets = (model,radius,name) => {
    for (const chain of g.chains(model)) {
        const orientation=winding(chain), links=chain.links
        for (let i=0;i<links.length;i++) {
            const arc=links[i]
            if (!concaveArc(arc,orientation)) { continue }
            if (arc.walkedPath.pathContext.radius<radius-g.TOLERANCE) { g.fail(name,'Inside radius cannot fit; reduce its size') }
            for (const [first,last] of [[links[(i+links.length-1)%links.length],arc],[arc,links[(i+1)%links.length]]]) {
                const point=ends(first)[1], a=direction(first,point), b=direction(last,point)
                if (Math.abs(cross(a,b))>g.TOLERANCE/radius || a[0]*b[0]+a[1]*b[1]<0) {
                    g.fail(name,'Corner relief cannot meet adjacent edges tangentially; reduce its size')
                }
            }
        }
    }
}
const filletInside = (model,radius) => {
    const result=flat(model)
    let unresolved=false, index=0
    for (const chain of g.chains(result)) {
        const orientation=winding(chain)
        for (let i=0;i<chain.links.length;i++) {
            const first=chain.links[i], last=chain.links[(i+1)%chain.links.length]
            if (concaveArc(first,orientation) && first.walkedPath.pathContext.radius<radius-g.TOLERANCE) { unresolved=true }
            if (!first.endPoints || !last.endPoints) { continue }
            const point=ends(first)[1]
            const turn=cross(direction(first,point),direction(last,point))
            if (turn*orientation>=-g.EPSILON) { continue }
            const arc=m.path.fillet(first.walkedPath.pathContext,last.walkedPath.pathContext,radius)
            if (arc) { result.paths[`fillet${index++}`]=arc } else { unresolved=true }
        }
    }
    // Short stagger steps can require a fillet to span an adjacent convex arc.
    if (!unresolved) { return result }
    const closed=g.close(result,radius)
    // Closing a narrow bay can enclose a new void; a solid perimeter needs that filled.
    // Existing holes retain the topology guard and must never be filled implicitly.
    if (g.chains(model).some(chain=>chain.contains?.length)) { return closed }
    return g.union(g.chains(closed).map(chain=>m.chain.toNewModel(chain)))
}
const bevelArc = (path,model) => {
    const midpoint=m.point.middle(path), vector=subtract(path.origin,midpoint)
    const step=Math.min(path.radius/2,g.TOLERANCE*10)
    const probe=midpoint.map((value,i)=>value+vector[i]*step/path.radius)
    const outside=m.measure.isPointInsideModel(probe,model)
    const span=((path.endAngle-path.startAngle)%360+360)%360 || 360
    const count=Math.ceil(span/MAX_BEVEL_SWEEP), paths=[]
    const point = (angle,radius=path.radius) => {
        const radians=angle*Math.PI/180
        return [path.origin[0]+radius*Math.cos(radians),path.origin[1]+radius*Math.sin(radians)]
    }
    const meet = (a,b) => point((a+b)/2,path.radius/Math.cos((b-a)*Math.PI/360))
    for (let i=0;i<count;i++) {
        const start=path.startAngle+i*span/count, end=start+span/count
        const middle=(start+end)/2
        // Outside bevels circumscribe the arc, retaining the complete clearance envelope.
        const points=outside?[point(start),meet(start,middle),meet(middle,end),point(end)]:[point(start),point(end)]
        for (let j=1;j<points.length;j++) { paths.push(new m.paths.Line(points[j-1],points[j])) }
    }
    return paths
}
const stepCandidate = (model,first,run,last,orientation,limit) => {
    const a=direction(first,ends(first)[1]), b=direction(last,ends(last)[0])
    if (Math.abs(cross(a,b))>g.EPSILON || a[0]*b[0]+a[1]*b[1]<0) { return null }
    const start=ends(first)[1], gap=subtract(ends(last)[0],start)
    const height=cross(a,gap)
    if (Math.abs(height)<g.TOLERANCE) { return null }
    const diagonal=[a[0]-Math.sign(height)*a[1],a[1]+Math.sign(height)*a[0]]
    const normal=[-diagonal[1],diagonal[0]]
    const support=Math.min(0,...run.flatMap(link=>ends(link).map(point=>orientation*cross(diagonal,subtract(point,start)))))
    const normalSquared=normal[0]**2+normal[1]**2
    const origin=start.map((value,i)=>value+normal[i]*orientation*support/normalSquared)
    const guide={endPoints:[origin,origin.map((value,i)=>value+diagonal[i])],reversed:false}
    const from=intersection(first,guide), to=intersection(last,guide)
    if (!from || !to || distance(from,start)>limit || distance(to,ends(last)[0])>limit) { return null }
    if (subtract(from,ends(first)[0]).reduce((sum,v,i)=>sum+v*a[i],0)<=g.EPSILON ||
        subtract(ends(last)[1],to).reduce((sum,v,i)=>sum+v*b[i],0)<=g.EPSILON) { return null }
    const candidate=g.clone(model)
    candidate.paths[first.walkedPath.pathId][first.reversed?'origin':'end']=from
    candidate.paths[last.walkedPath.pathId][last.reversed?'end':'origin']=to
    for (const link of run) { delete candidate.paths[link.walkedPath.pathId] }
    candidate.paths[`${first.walkedPath.pathId}_step`]=new m.paths.Line(from,to)
    try {
        g.validate(candidate,'designs')
        return g.contains(candidate,model)?candidate:null
    } catch (error) {
        if (!(error instanceof g.DesignError)) { throw error }
        return null
    }
}
const chamferSteps = (source,size) => {
    let model=source
    // Two neighboring corner reliefs form one bounded transition between parallel edges.
    const limit=2*Math.SQRT2*size
    for (;;) {
        let replacement
        for (const chain of g.chains(model)) {
            const links=chain.links, orientation=winding(chain)
            for (let i=0;i<links.length && !replacement;i++) {
                const first=links[i]
                if (first.walkedPath.pathContext.type!=='line' || first.pathLength<=limit) { continue }
                const run=[]
                let length=0
                for (let step=1;step<links.length;step++) {
                    const next=links[(i+step)%links.length]
                    if (next.walkedPath.pathContext.type!=='line') { break }
                    if (next.pathLength>limit) {
                        if (run.length>1) { replacement=stepCandidate(model,first,run,next,orientation,limit) }
                        break
                    }
                    length+=next.pathLength
                    if (length>limit) { break }
                    run.push(next)
                }
            }
            if (replacement) { break }
        }
        if (!replacement) { return model }
        model=replacement
        m.model.simplify(model)
    }
}
const corners = (model,spec,name) => {
    let result
    try {
        result=filletInside(model,spec.fillet || spec.chamfer)
    } catch (error) {
        if (!(error instanceof g.DesignError)) { throw error }
        g.fail(name,error.diagnostics[0].message,error.diagnostics[0].code)
    }
    checkFillets(result,spec.fillet || spec.chamfer,name)
    if (spec.chamfer) {
        const curved=result
        result=flat(result)
        // Both inside relief and existing outside fillets become straight edges.
        for (const [id,path] of Object.entries(result.paths)) {
            if (path.type!=='arc') { continue }
            delete result.paths[id]
            bevelArc(path,curved).forEach((line,index)=> { result.paths[`${id}_${index}`]=line })
        }
        m.model.simplify(result)
        result=chamferSteps(result,spec.chamfer)
    }
    if (JSON.stringify(topology(result))!==JSON.stringify(topology(model))) {
        g.fail(name,'Corner relief joins separate regions or closes a hole; reduce its size')
    }
    g.validate(result,name)
    g.requireContains(result,model,name)
    return result
}
module.exports = {simplify,corners}
