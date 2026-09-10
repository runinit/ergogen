const g = require("../designs/geometry")
const f = require("./frames")
const solver = require("../designs/solver")
const layout = require("./layout")

const TOLERANCE = 0.00001
const AXIS_LENGTH = 10
const wrap = (angle) => ((angle + 540) % 360) - 180
const key = (ref) => {
    const normalized = ref.replace(/\.origin$/, "")
    return /^(objects|clusters|layers|mirror)\./.test(normalized) ||
        normalized === "world"
        ? normalized
        : `objects.${normalized}`
}

// A frame is a point and a directed axis. Its children retain their local geometry.
exports.resolve = async (config, options = {}) => {
    const scene = layout.resolve(config)
    const rules = config.layout.constraints || {}
    const movable = Object.entries(scene.placements).filter(
        ([, item]) => item.spec?.solve?.length
    )
    if (!Object.keys(rules).length && !movable.length) {
        return scene
    }
    const first = movable[0]?.[1]
    const firstRef = Object.values(rules)[0]?.refs[0]
    const normal =
        first?.editMatrix ||
        (firstRef ? scene.reference(firstRef).matrix : f.identity())
    const n = [normal[2], normal[6], normal[10]]
    const seed = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const dot = seed.reduce((sum, value, index) => sum + value * n[index], 0)
    const projected = seed.map((value, index) => value - dot * n[index]),
        length = Math.hypot(...projected)
    const x = projected.map((value) => value / length),
        y = [
            n[1] * x[2] - n[2] * x[1],
            n[2] * x[0] - n[0] * x[2],
            n[0] * x[1] - n[1] * x[0]
        ]
    const plane = [
        x[0],
        y[0],
        n[0],
        0,
        x[1],
        y[1],
        n[1],
        0,
        x[2],
        y[2],
        n[2],
        0,
        0,
        0,
        0,
        1
    ]
    const inverse = f.inverse(plane)
    const planar = (matrix, path) => {
        const relative = f.multiply(inverse, matrix)
        if (Math.abs(relative[10] - 1) > TOLERANCE) {
            g.fail(
                path,
                "Layout constraints require parallel mounting planes",
                "constraint"
            )
        }
        return relative
    }
    const primitives = [],
        owners = {},
        nodes = {},
        active = new Set(),
        checks = []
    let serial = 0
    const add = (primitive, owner) => {
        const id = String(++serial)
        primitives.push({ id, ...primitive })
        if (owner) {
            owners[id] = owner
        }
        return id
    }
    const point = (matrix, fixed) =>
        add({ type: "point", x: matrix[3], y: matrix[7], fixed })
    const line = (p, q) => add({ type: "line", p1_id: p, p2_id: q })
    const axis = (p, matrix, fixed) => {
        const q = point(f.multiply(matrix, f.local([AXIS_LENGTH, 0, 0])), fixed)
        if (!fixed) {
            add({
                type: "p2p_distance",
                p1_id: p,
                p2_id: q,
                distance: AXIS_LENGTH
            })
        }
        return { q, l: line(p, q) }
    }
    const angle = (a, b, value, owner) =>
        add(
            { type: "l2l_angle_ll", l1_id: a, l2_id: b, angle: value * f.RAD },
            owner
        )
    const fixed = (matrix) => {
        const p = point(matrix, true)
        return { p, ...axis(p, matrix, true), matrix, dynamic: false }
    }
    const rigid = (parent, matrix) => {
        if (!parent.dynamic) {
            return fixed(matrix)
        }
        const local = f.multiply(f.inverse(parent.matrix), matrix),
            distance = Math.hypot(local[3], local[7])
        let p = parent.p
        if (distance > TOLERANCE) {
            p = point(matrix, false)
            add({ type: "p2p_distance", p1_id: parent.p, p2_id: p, distance })
            angle(
                parent.l,
                line(parent.p, p),
                Math.atan2(local[7], local[3]) / f.RAD
            )
        }
        const direction = axis(p, matrix, false)
        angle(parent.l, direction.l, f.yaw(local))
        return { p, ...direction, matrix, dynamic: true }
    }
    const freeFrame = (parent, matrix, free) => {
        if (!free.length) {
            return rigid(parent, matrix)
        }
        let p
        if (!free.includes("x") && !free.includes("y")) {
            p = rigid(parent, matrix).p
        } else {
            p = point(matrix, false)
            if (!free.includes("x") || !free.includes("y")) {
                const seed = [...matrix]
                for (const index of [0, 1, 4, 5]) {
                    seed[index] = parent.matrix[index]
                }
                const guide = rigid(parent, seed)
                let l = guide.l
                if (!free.includes("x")) {
                    const rotated = rigid(
                        guide,
                        f.multiply(seed, f.local([0, 0, 0], 90))
                    )
                    l = rotated.l
                }
                add({ type: "point_on_line_pl", p_id: p, l_id: l })
            }
        }
        const direction = axis(p, matrix, false)
        if (!free.includes("rotate")) {
            angle(
                parent.l,
                direction.l,
                f.yaw(f.multiply(f.inverse(parent.matrix), matrix))
            )
        }
        return { p, ...direction, matrix, dynamic: true }
    }
    nodes.world = fixed(f.identity())
    const frame = (reference) => {
        const id = key(reference)
        if (nodes[id]) {
            return nodes[id]
        }
        if (active.has(id)) {
            g.fail(
                "layout.constraints",
                `Cyclic solver frame ${id}`,
                "constraint"
            )
        }
        active.add(id)
        // Resolving an attachment records its parent frame without authoring a hidden object.
        const resolved = scene.placements[id] || scene.reference(reference)
        const entry = scene.placements[id]
        const matrix = planar(
            entry?.matrix || resolved.matrix,
            entry?.path || reference
        )
        if (!entry) {
            nodes[id] = fixed(matrix)
        } else if (entry.mirror) {
            const original = frame(entry.mirror)
            if (!original.dynamic) {
                nodes[id] = fixed(matrix)
            } else {
                const p = point(matrix, false),
                    direction = axis(p, matrix, false)
                const start = f.transform(inverse, [entry.axis, 0, 0]),
                    end = f.transform(inverse, [entry.axis, AXIS_LENGTH, 0])
                const symmetry = line(
                    point(f.local(start), true),
                    point(f.local(end), true)
                )
                add({
                    type: "p2p_symmetric_ppl",
                    p1_id: original.p,
                    p2_id: p,
                    l_id: symmetry
                })
                const reflected = point(
                    f.multiply(matrix, f.local([-AXIS_LENGTH, 0, 0])),
                    false
                )
                add({
                    type: "p2p_symmetric_ppl",
                    p1_id: original.q,
                    p2_id: reflected,
                    l_id: symmetry
                })
                add({
                    type: "p2p_symmetric_ppp",
                    p1_id: direction.q,
                    p2_id: reflected,
                    p_id: p
                })
                nodes[id] = { p, ...direction, matrix, dynamic: true }
            }
        } else {
            const parent = frame(entry.parent)
            const edit = rigid(parent, planar(entry.editMatrix, entry.path))
            const item =
                scene.objects[id.replace(/^objects\./, "")] ||
                scene.clusters[id.replace(/^clusters\./, "")]
            const free = item?.locked ? [] : entry.spec.solve || []
            nodes[id] = { ...freeFrame(edit, matrix, free), edit, entry, free }
        }
        active.delete(id)
        return nodes[id]
    }
    for (const [id] of movable) {
        frame(id)
    }
    for (const [id, spec] of Object.entries(rules)) {
        const path = `layout.constraints.${id}`
        const refs = spec.refs.map((ref) => frame(ref))
        const exact =
            spec.type === "symmetric"
                ? 3
                : ["horizontal", "vertical", "equal_spacing"].includes(
                        spec.type
                    )
                  ? undefined
                  : 2
        if (
            (exact && refs.length !== exact) ||
            (spec.type === "equal_spacing" && refs.length < 3)
        ) {
            g.fail(
                path,
                "Choose the required number of references",
                "constraint"
            )
        }
        const value =
            spec.value === undefined
                ? undefined
                : scene.number(spec.value, `${path}.value`)
        if (["distance", "angle"].includes(spec.type) && value === undefined) {
            g.fail(path, "Enter a driving dimension", "constraint")
        }
        const [a, b, c] = refs
        const pair = { p1_id: a.p, p2_id: b.p }
        switch (spec.type) {
            case "coincident":
                add({ type: "p2p_coincident", ...pair }, id)
                break
            case "horizontal":
            case "vertical":
                for (const next of refs.slice(1)) {
                    add(
                        { type: `${spec.type}_pp`, p1_id: a.p, p2_id: next.p },
                        id
                    )
                }
                break
            case "distance":
                if (spec.axis) {
                    add(
                        {
                            type: "difference",
                            param1: { o_id: a.p, prop: spec.axis },
                            param2: { o_id: b.p, prop: spec.axis },
                            difference: value
                        },
                        id
                    )
                } else {
                    if (value < 0) {
                        g.fail(
                            path,
                            "Distance must be nonnegative",
                            "dimension"
                        )
                    }
                    add(
                        {
                            type:
                                value === 0 ? "p2p_coincident" : "p2p_distance",
                            ...pair,
                            ...(value === 0 ? {} : { distance: value })
                        },
                        id
                    )
                }
                break
            case "angle":
                angle(a.l, b.l, value, id)
                break
            case "equal_spacing": {
                for (let index = 2; index < refs.length; index++) {
                    add(
                        {
                            type: "p2p_symmetric_ppp",
                            p1_id: refs[index - 2].p,
                            p2_id: refs[index].p,
                            p_id: refs[index - 1].p
                        },
                        id
                    )
                }
                break
            }
            case "symmetric": {
                const guide =
                    spec.axis === "y"
                        ? rigid(c, f.multiply(c.matrix, f.local([0, 0, 0], 90)))
                        : c
                add({ type: "p2p_symmetric_ppl", ...pair, l_id: guide.l }, id)
                break
            }
            default:
                g.fail(path, `Unknown constraint ${spec.type}`, "constraint")
        }
        checks.push({ id, spec, value })
    }
    const result = await solver.analyze(primitives, "layout", options)
    const ids = (list) => [
        ...new Set(list.map((id) => owners[id]).filter(Boolean))
    ]
    if (!result.valid) {
        const conflicts = ids(result.conflicts)
        const error = new g.DesignError(
            "layout.constraints",
            "No valid layout solution",
            "constraint"
        )
        error.diagnostics = (
            conflicts.length ? conflicts : Object.keys(rules)
        ).map((id) => ({
            feature: `layout.constraints.${id}`,
            sourcePath: `layout.constraints.${id}`,
            code: "constraint",
            severity: "error",
            message: `${rules[id]?.label || id}: conflicts with the other driving rules or locked placements.`
        }))
        if (!error.diagnostics.length) {
            error.diagnostics = [
                {
                    feature: "layout.constraints",
                    sourcePath: "layout.constraints",
                    code: "constraint",
                    severity: "error",
                    message: "No valid layout solution"
                }
            ]
        }
        throw error
    }
    const solved = Object.fromEntries(
        result.primitives.map((item) => [item.id, item])
    )
    const matrixOf = (node) => {
        const p = solved[node.p],
            q = solved[node.q]
        return f.local(
            [p.x, p.y, node.matrix[11]],
            Math.atan2(q.y - p.y, q.x - p.x) / f.RAD
        )
    }
    const offsets = {}
    for (const node of Object.values(nodes)) {
        if (!node.free?.length) {
            continue
        }
        const local = f.multiply(f.inverse(matrixOf(node.edit)), matrixOf(node))
        const before = f.multiply(f.inverse(node.edit.matrix), node.matrix)
        offsets[node.entry.path] = {
            at: [0, 1]
                .map((axis) =>
                    node.free.includes(["x", "y"][axis])
                        ? local[axis * 4 + 3] - before[axis * 4 + 3]
                        : 0
                )
                .concat(0),
            rotate: node.free.includes("rotate")
                ? wrap(f.yaw(local) - f.yaw(before))
                : 0
        }
    }
    // Re-resolve dependents, mirrors and stacking; never mutate the authored document.
    const final = layout.resolve(config, offsets),
        dimensions = {}
    const values = (ref) => planar(final.reference(ref).matrix, ref)
    for (const { id, spec, value } of checks) {
        const matrices = spec.refs.map(values),
            [a, b, c] = matrices
        const dx = b[3] - a[3],
            dy = b[7] - a[7]
        let actual = 0,
            residual = 0
        if (spec.type === "distance") {
            actual =
                spec.axis === "x"
                    ? dx
                    : spec.axis === "y"
                      ? dy
                      : Math.hypot(dx, dy)
            residual = Math.abs(actual - value)
        }
        if (spec.type === "angle") {
            actual = wrap(f.yaw(b) - f.yaw(a))
            residual = Math.abs(wrap(actual - value))
        }
        if (spec.type === "coincident") {
            residual = Math.hypot(dx, dy)
        }
        if (spec.type === "horizontal" || spec.type === "vertical") {
            const index = spec.type === "horizontal" ? 7 : 3
            residual = Math.max(
                ...matrices.map((matrix) => Math.abs(matrix[index] - a[index]))
            )
        }
        if (spec.type === "equal_spacing") {
            residual = Math.max(
                ...matrices
                    .slice(2)
                    .map((matrix, index) =>
                        Math.hypot(
                            matrix[3] - matrices[index + 1][3] - dx,
                            matrix[7] - matrices[index + 1][7] - dy
                        )
                    )
            )
        }
        if (spec.type === "symmetric") {
            const axis = f.multiply(
                    c,
                    f.local([0, 0, 0], spec.axis === "y" ? 90 : 0)
                ),
                inv = f.inverse(axis)
            const left = f.transform(inv, f.position(a)),
                right = f.transform(inv, f.position(b))
            residual = Math.hypot(left[0] - right[0], left[1] + right[1])
        }
        if (!Number.isFinite(residual) || residual > TOLERANCE) {
            g.fail(
                `layout.constraints.${id}`,
                "Solved layout does not satisfy this driving rule",
                "constraint"
            )
        }
        dimensions[id] = { ...spec, actual, residual }
    }
    const redundant = ids(result.redundant)
    const dof = Math.max(0, result.dof)
    final.constraints = {
        status: dof ? "underconstrained" : "solved",
        dof,
        dimensions,
        redundant
    }
    for (const id of redundant) {
        final.findings.push({
            feature: `layout.constraints.${id}`,
            sourcePath: `layout.constraints.${id}`,
            severity: "warning",
            code: "constraint-redundant",
            message: `${rules[id].label || id}: this rule repeats another constraint.`
        })
    }
    return final
}
