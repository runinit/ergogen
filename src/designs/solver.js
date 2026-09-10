const g = require('./geometry')

let modulePromise

// Keep the LGPL solver independently loadable in Node and browser workers.
const analyze = async (primitives, name, options = {}) => {
    const load = options.loadSolver || (() => import('@salusoft89/planegcs'))
    const library = await load()
    if (!modulePromise) {
        modulePromise = library.init_planegcs_module(options.solverWasm ? {locateFile: () => options.solverWasm} : undefined)
            .catch(error => { modulePromise = undefined; throw error })
    }
    const module = await modulePromise
    const wrapper = new library.GcsWrapper(new module.GcsSystem(), module)
    try {
        wrapper.push_primitives_and_params(primitives)
        const status = wrapper.solve()
        const valid = [library.SolveStatus.Success, library.SolveStatus.Converged].includes(status)
        if (valid) { wrapper.apply_solution() }
        return {valid, status, dof:wrapper.gcs.dof(), conflicts:wrapper.get_gcs_conflicting_constraints(),
            redundant:wrapper.get_gcs_redundant_constraints(), primitives:wrapper.sketch_index.get_primitives()}
    } catch (error) {
        if (error instanceof g.DesignError) { throw error }
        g.fail(`${name}.constraints`, error.message || String(error), 'constraint')
    } finally {
        wrapper.destroy_gcs_module()
    }
}
exports.analyze = analyze
exports.solve = async (primitives, name, options = {}) => {
    const result = await analyze(primitives,name,options)
    if (!result.valid) { g.fail(`${name}.constraints`, `No valid solution (${result.conflicts.join(', ') || result.status})`, 'constraint') }
    return result.primitives
}
