const g = require('./geometry')

// Resolve cached footprint bindings once for native assembly export.
exports.place = async (kernel, component, assets, z, feature) => {
    const models = component.models || []
    const bindings = models.map(model => ({...model, asset: model.asset || model.path.replace(/^\$\{KIPRJMOD\}\/models\//, '')}))
    if (!bindings.length || bindings.some(model => !assets[model.asset])) { return null }
    const solids = []
    for (const binding of bindings) {
        const source = assets[binding.asset]
        let imported
        if (/\.(step|stp)$/i.test(binding.asset)) {
            imported = await kernel.import(source)
        } else {
            const metadata = assets[`__model_${binding.asset}.json`]
            const mesh = (metadata && JSON.parse(metadata).stl) || (/\.stl$/i.test(binding.asset) ? source : null)
            if (!mesh) { g.fail(feature, 'Import this mesh in Components before generating its STEP reference.', 'missing-asset') }
            const bytes = mesh.startsWith('base64:') ? Uint8Array.from(atob(mesh.slice(7)), char => char.charCodeAt(0)) : new TextEncoder().encode(mesh)
            imported = await kernel.importMesh(bytes)
        }
        solids.push(kernel.placeModel(imported, binding, component, z))
    }
    return kernel.compound(solids)
}
