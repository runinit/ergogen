const g = require('./geometry')
const tooling = require('./tooling')

const intersects = (left, right) => !g.empty(g.combine(left, right, 'intersect'))

// Validate tool removal before the solid compiler changes any manufactured part.
exports.prepare = (pockets, spec, bounds, name) => {
    const candidates = pockets.map(entry => ({...entry, nominal: entry.model,
        model: tooling.prepare(entry.model, spec.manufacturing[entry.part])}))
    const boundaries = new Map(), webs = new Map()
    return candidates.map(entry => {
        const {part, id, nominal, model} = entry
        const process = spec.manufacturing[part]
        let adjusted = JSON.stringify(model) !== JSON.stringify(nominal)
        let failure
        if (adjusted) {
            const path = `${name}.${part}.${id}`
            g.validate(model, path)
            g.requireContains(model, nominal, path)
            const minWall = process.min_wall ?? (part === 'plate' ? spec.plate : spec.wall)
            const boundary = part === 'plate' ? bounds.plate : bounds.shell
            const post = bounds.posts.find(post => post.id === id)
            if (!boundaries.has(part)) { boundaries.set(part, g.offset(boundary, -minWall)) }
            const web = peer => {
                if (!webs.has(peer)) { webs.set(peer, g.offset(peer.model, minWall)) }
                return webs.get(peer)
            }
            if (!g.contains(boundaries.get(part), model)) {
                failure = 'Cutter relief would breach the minimum wall. Use a smaller cutter or increase the surrounding material.'
            } else if (post && !g.contains(g.offset(post.model, -(post.min_wall ?? minWall)), model)) {
                failure = 'Cutter relief would thin the post wall around this hardware pocket. Use a smaller cutter or enlarge the post.'
            } else if (part === 'plate' && candidates.some(peer => peer !== entry && peer.part === part && intersects(model, web(peer)))) {
                failure = 'Cutter relief would thin the web between plate openings. Use a smaller cutter or increase their spacing.'
            } else if (bounds.posts.some(post => post.id !== id && !g.contains(nominal, g.combine(model, post.model, 'intersect')))) {
                failure = 'Cutter relief overlaps a mounting post. Move the post or use a smaller cutter.'
            }
            if (failure) { adjusted = false }
        }
        const prepared = failure ? nominal : model
        return {...entry, model: prepared, radius: tooling.radius(prepared), adjusted, failure}
    })
}
