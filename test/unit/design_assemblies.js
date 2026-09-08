const engine = require('../../src/ergogen')
const base = preset => ({points: {zones: {key: {}}},
    outlines: {edge: [{what: 'rectangle', size: [60, 40]}]},
    designs: {regions: {edge: {outline: 'edge'}}, profiles: {pcb: {from: 'regions.edge'}},
        assemblies: {case: {preset, profile: 'profiles.pcb', wall: 3, floor: 2, height: 10, plate: 1.5, fit: 0.3,
            layers: {bottom: {thickness: 2}, spacer: {thickness: 6, cavity: true}, top: {thickness: 2, cavity: true}},
            mounts: {one: {anchor: {shift: [25, 15]}, hole: 1.2, post: 3, height: 5}},
            gasket: {thickness: 2, compression: 0.2, fit: 0.2},
            gaskets: {left: {anchor: {shift: [-30, 0]}, size: [5, 10]}}
        }}
    }})

describe('Design assemblies', function() {
    this.timeout(30000)
    for (const [preset, parts] of Object.entries({plate: ['plate'], tray: ['tray'], stacked: ['bottom', 'spacer', 'top'], gasket: ['bottom', 'top', 'plate']})) {
        it(`compiles ${preset} into separate existing case operations`, async () => {
            const result = await engine.process(base(preset), {debug: true})
            for (const part of parts) { expect(result.cases[`case_${part}`].jscad).to.include('function main') }
            expect(result.designs.assemblies.case.mounts.one.position).to.deep.equal([25, 15])
        })
    }
    it('rejects posts outside the enclosure and colliding component envelopes', async () => {
        const input = base('tray')
        input.designs.assemblies.case.mounts.one.anchor.shift = [100, 100]
        await expect(engine.process(input)).to.be.rejectedWith('mounts.one')
        input.designs.assemblies.case.mounts.one.anchor.shift = [25, 15]
        input.designs.components = {battery: {anchor: {shift: [25, 15]}, size: [10, 10], height: [2, 8]}}
        input.designs.assemblies.case.components = ['components.battery']
        await expect(engine.process(input)).to.be.rejectedWith('components.battery')
    })
    it('suggests gasket tabs along clear edges with editable anchors', async () => {
        const input = base('plate')
        input.designs.assemblies.case.suggest = {gaskets: {spacing: 30, size: [12, 4]}}
        const result = await engine.process(input, {debug: true})
        const tabs = result.designs.assemblies.case.suggestions.filter(item => item.kind === 'gasket')
        expect(tabs.length).to.be.greaterThan(1)
        expect(tabs[0].definition.anchor.feature).to.equal('profiles.pcb')
        input.designs.assemblies.case.gaskets[tabs[0].id] = tabs[0].definition
        const accepted = await engine.process(input, {debug: true})
        expect(accepted.designs.assemblies.case.suggestions.map(item => item.id)).not.to.include(tabs[0].id)
    })
    it('returns repeatable suggestions without silently installing mounts', async () => {
        const input = base('tray')
        delete input.designs.assemblies.case.mounts
        input.designs.assemblies.case.suggest = {spacing: 30, inset: 5, post: 2}
        const result = await engine.process(input, {debug: true})
        expect(result.designs.assemblies.case.suggestions.length).to.be.greaterThan(2)
        expect(result.designs.assemblies.case.mounts).to.deep.equal({})
    })
})
