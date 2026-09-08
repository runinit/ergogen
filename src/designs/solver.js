const g = require('./geometry')

let modulePromise

// Keep the LGPL solver independently loadable in Node and browser workers.
exports.solve = async (primitives, name, options = {}) => {
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
        if (![library.SolveStatus.Success, library.SolveStatus.Converged].includes(status)) {
            g.fail(`${name}.constraints`, `No valid solution (${wrapper.get_gcs_conflicting_constraints().join(', ') || status})`, 'constraint')
        }
        wrapper.apply_solution()
        return wrapper.sketch_index.get_primitives()
    } catch (error) {
        if (error instanceof g.DesignError) { throw error }
        g.fail(`${name}.constraints`, error.message || String(error), 'constraint')
    } finally {
        wrapper.destroy_gcs_module()
    }
}
