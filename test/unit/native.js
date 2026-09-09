const assert = require('node:assert/strict')
const engine = require('../../src/ergogen')

const fixture = () => ({
    schema: 'ergogen/v1',
    parts: {key: {revision: '1', envelopes: {pcb: {size: [18, 18]}, body: {size: [14, 14], height: [0, 5]}}}},
    layout: {objects: {
        key: {kind: 'key', part: 'key'},
        reference: {kind: 'anchor', placement: {at: [30, 0, 0]}}
    }},
    designs: {regions: {keys: {select: {kind: 'key'}, envelope: 'pcb'}}, profiles: {board: {from: 'regions.keys'}}}
})

describe('Native object contract', () => {
    it('keeps reference anchors available without growing board geometry', async () => {
        const result = await engine.process(fixture(), {debug: true, analysis: true})
        assert.equal(result.layout.objects.reference.position[0], 30)
        assert.equal(result.designs.features['profiles.board'].bounds.width, 18)
    })

    it('rejects legacy input and unknown native properties without rewriting source', async () => {
        await assert.rejects(engine.process({points: {zones: {key: {}}}}), /schema: ergogen\/v1/)
        const source = 'schema: ergogen/v1\nlayout: {}\nunexpected: true\n'
        await assert.rejects(engine.process(source), error => error.diagnostics[0].location.line === 3)
    })
})

const stack = () => ({
    schema: 'ergogen/v1',
    parts: {
        controller: {revision: '1', envelopes: {body: {size: [18, 30], height: [0, 6]}}},
        display: {revision: '1', envelopes: {body: {size: [18, 30], height: [0, 2]}}},
        battery: {revision: '1', envelopes: {body: {size: [20, 30], height: [0, 4]}}}
    },
    pcbs: {main: {thickness: 1.6}},
    layout: {
        layers: {electronics: {surface: 'pcb.main.top'}, floor: {surface: 'case.keyboard.floor', assembly: 'keyboard'}},
        objects: {
            mcu: {kind: 'component', part: 'controller', layer: 'electronics'},
            screen: {kind: 'component', part: 'display', layer: 'electronics', placement: {ref: 'mcu', above: 'mcu.body.top', gap: 1}},
            battery: {kind: 'component', part: 'battery', layer: 'floor', placement: {at: [40, 0, 1]}}
        }
    },
    designs: {assemblies: {keyboard: {floor: 2, height: 24, wall: 3}}}
})

describe('Physical stacking', () => {
    const resolve = input => require('../../src/native/layout').resolve(input)

    it('stacks the screen above the MCU and leaves the battery on the case floor', () => {
        const scene = resolve(stack())
        assert.equal(scene.objects.mcu.position[2], 7.6)
        assert.equal(scene.objects.screen.position[2], 14.6)
        assert.equal(scene.objects.battery.position[2], 3)
    })

    it('updates dependent heights without moving independently supported objects', () => {
        const input = stack()
        input.parts.controller.envelopes.body.height[1] = 8
        input.pcbs.main.thickness = 2
        input.designs.assemblies.keyboard.floor = 3
        const scene = resolve(input)
        assert.equal(scene.objects.screen.position[2], 17)
        assert.deepEqual(scene.objects.battery.position, [40, 0, 4])
    })

    it('keeps stacked bodies clear while reporting an actual height overlap', () => {
        const input = stack()
        assert.equal(resolve(input).findings.length, 0)
        delete input.layout.objects.screen.placement.above
        assert.ok(resolve(input).findings.some(finding => finding.code === 'body-overlap'))
    })

    it('reports insufficient case height without resizing the enclosure', () => {
        const input = stack()
        input.parts.controller.envelopes.body.height[1] = 20
        assert.ok(resolve(input).findings.some(finding => finding.code === 'case-height'))
        assert.equal(input.designs.assemblies.keyboard.height, 24)
    })

    it('rejects cycles and contradictory vertical drivers', () => {
        const input = stack()
        input.layout.objects.mcu.placement = {above: 'screen.body.top'}
        assert.throws(() => resolve(input), /Cyclic placement/)
        delete input.layout.objects.mcu.placement
        input.layout.objects.screen.placement.below = 'mcu.body.bottom'
        assert.throws(() => resolve(input), /one vertical/)
    })
})

module.exports = {fixture}

describe('Editable native frames', () => {
    it('mirrors column members once and edits only the mirrored instance', () => {
        const input = fixture()
        input.layout.clusters = {
            left: {arrangement: {type: 'columns', columns: ['a','b'], rows: ['one'], pitch: [19,19]}},
            right: {mirror: {source: 'left', axis: 50}, overrides: {key: {placement: {override: {at: [2,0,0]}}}}}
        }
        input.layout.objects.key.cluster = 'left'
        input.layout.objects.key.cell = ['b','one']
        const scene = require('../../src/native/layout').resolve(input)
        assert.equal(scene.objects.key.position[0], 19)
        assert.equal(scene.objects.right__key.position[0], 83)
        assert.equal(scene.objects.right__key.sourcePath, 'layout.clusters.right.overrides.key')
        assert.equal(scene.objects.key.editMatrix.length, 16)
    })
})

describe('Native PCB adapter', () => {
    it('retains copper obstacles and physical PCB thickness', async () => {
        const input = fixture()
        input.pcbs = {main: {profile: 'profiles.board', thickness: 2}}
        input.layout.objects.key.pcb = 'main'
        input.layout.objects.key.footprints = {switch: {what: 'mx', params: {from: 'COL0', to: 'ROW0'}}}
        input.designs.assemblies = {keyboard: {preset: 'enclosure', profile: 'profiles.board', board: {source: 'generated', name: 'main'}, mounting: 'bottom', ledge: {width: 2}}}
        const output = await engine.process(input, {debug: true, analysis: true})
        assert.match(output.pcbs.main, /thickness 2\)/)
        assert.ok(output.designs.boards.keyboard.obstacles.length > 0)
        const board = require('../../src/designs/board-inventory').read(output.pcbs.main)
        assert.deepEqual(require('makerjs').measure.modelExtents(board.model).low, [-9,-9])
    })
})

it('checks floating travel against a separately mounted battery', () => {
    const input = stack()
    input.designs.assemblies.keyboard.mounting = 'gasket'
    input.designs.assemblies.keyboard.board = {source: 'generated', name: 'main'}
    input.designs.assemblies.keyboard.gasket = {travel_down: '0.8', travel_up: 0.2, travel_side: 0.1}
    input.layout.objects.battery.placement = {at: [0,0,1]}
    const scene = require('../../src/native/layout').resolve(input)
    assert.equal(scene.objects.screen.motion, 'floating')
    assert.equal(scene.objects.battery.motion, 'fixed')
    assert.ok(scene.findings.some(item => item.code === 'body-overlap'))
})

it('locates semantic placement errors in the authored YAML', async () => {
    const source = 'schema: ergogen/v1\nlayout:\n  objects:\n    bad:\n      kind: anchor\n      placement: {ref: missing}\n'
    await assert.rejects(engine.process(source), error => error.diagnostics[0].location?.line === 6)
})

it('moves mirrored clusters as a group while retaining mirrored member spacing', () => {
    const input=fixture()
    input.layout.objects.key.cluster='left'
    input.layout.objects.key.placement={at:[19,0,0]}
    input.layout.clusters={left:{},right:{mirror:{source:'left',axis:50},placement:{override:{at:[10,4,0],rotate:0}}}}
    const scene=require('../../src/native/layout').resolve(input)
    assert.deepEqual(scene.objects.right__key.position,[91,4,0])
})

it('reports a floor-mounted battery that crosses PCB material', async () => {
    const input = stack()
    input.pcbs.main.profile='profiles.board'
    input.layout.objects.battery.placement={at:[0,0,1]}
    input.parts.battery.envelopes.body.height=[0,6]
    input.designs.regions={board:{shape:{size:[60,40]}}}
    input.designs.profiles={board:{from:'regions.board'}}
    input.designs.assemblies.keyboard={...input.designs.assemblies.keyboard,preset:'enclosure',profile:'profiles.board',board:{source:'generated',name:'main'},mounting:'bottom',ledge:{width:2}}
    const result=await engine.process(input,{analysis:true})
    assert.ok(result.layout.findings.some(item=>item.code==='pcb-overlap'))
})

it('uses a PCB object as a planar reference without transferring its height to a floor-mounted battery', () => {
    const input=stack()
    input.layout.objects.mcu.placement={at:[15,10,0]}
    input.layout.objects.battery.placement={ref:'mcu',at:[30,0,1]}
    const result=require('../../src/native/layout').resolve(input)
    assert.deepEqual(result.objects.battery.position,[45,10,3])
    assert.equal(result.objects.battery.motion,'fixed')
})

it('checks PCB travel even where no component body overlaps the battery', async () => {
    const input=stack()
    input.pcbs.main.profile='profiles.board'
    input.layout.objects.mcu.placement={at:[-20,0,0]}
    input.layout.objects.battery.placement={at:[20,0,1]}
    input.parts.battery.envelopes.body.height=[0,2.8]
    input.designs.regions={board:{shape:{size:[80,60]}}}
    input.designs.profiles={board:{from:'regions.board'}}
    input.designs.assemblies.keyboard={...input.designs.assemblies.keyboard,preset:'enclosure',profile:'profiles.board',board:{source:'generated',name:'main'},mounting:'gasket',gasket:{travel_down:0.4}}
    const result=await engine.process(input,{analysis:true})
    assert.ok(result.layout.findings.some(item=>item.code==='pcb-overlap'))
})

it('cuts declared corner relief into native plate openings', () => {
    const geometry=require('../../src/native/geometry')
    const m=require('makerjs')
    const plain=m.measure.modelExtents(geometry.shape({size:[14,14]}))
    const relieved=m.measure.modelExtents(geometry.shape({size:[14,14],corner_relief:0.5}))
    assert.ok(relieved.high[0]>plain.high[0])
    assert.throws(()=>geometry.shape({size:[14,14],corner_relief:5}),/relief/)
})

it('rejects ambiguous physical ownership when two assemblies use the same PCB', () => {
    const input=stack()
    input.designs.assemblies.keyboard.board={source:'generated',name:'main'}
    input.designs.assemblies.second={...input.designs.assemblies.keyboard,pcb_z:12}
    assert.throws(()=>require('../../src/native/layout').resolve(input),/one assembly/)
})

it('builds a case with native plate envelopes and no electrical PCB', async () => {
    const input=fixture()
    input.parts.key.envelopes.plate={size:[14,14]}
    input.designs.assemblies={tray:{preset:'tray',profile:'profiles.board',lid:2}}
    const result=await engine.process(input,{analysis:true})
    assert.ok(result.cases.tray_lid)
})

it('places native polygon regions using their declared envelope offset', async () => {
    const input={schema:'ergogen/v1',layout:{objects:{}},designs:{regions:{triangle:{shape:{polygon:[[0,0],[10,0],[0,10]],at:[30,20,0]}}}}}
    const result=await engine.process(input,{analysis:true})
    assert.deepEqual(result.designs.features['regions.triangle'].bounds.low,[30,20])
})

it('reports an unmeasured component even when no envelope was supplied', async () => {
    const input={schema:'ergogen/v1',layout:{objects:{connector:{kind:'component'}}}}
    const result=await engine.process(input,{layoutOnly:true})
    assert.ok(result.layout.findings.some(item=>item.code==='component-height'))
})

it('exports model associations on imported boards', async () => {
    const fs=require('fs')
    const source=fs.readFileSync(require('path').resolve(__dirname,'../fixtures/native-baseline/imported-controller.kicad_pcb'),'utf8')
    const inventory=require('../../src/designs/board-inventory').read(source)
    const id=inventory.components[0].id
    const boards=require('../../src/native/boards').sources({designs:{assemblies:{case:{board:{source:'asset',name:'board.kicad_pcb',models:{[id]:[{path:'${KIPRJMOD}/models/controller.wrl'}]}}}}}},{},{'board.kicad_pcb':source})
    assert.ok(boards.case.source.includes('${KIPRJMOD}/models/controller.wrl'))
})

describe('Authored cluster envelopes and parts', () => {
    it('wraps separated keys within a cluster without filling between clusters', async () => {
        const input = fixture()
        input.layout.clusters = {left: {arrangement: {type: 'free'}}, right: {arrangement: {type: 'free'}}}
        input.layout.objects = {
            a: {kind: 'key', part: 'key', cluster: 'left'},
            b: {kind: 'key', part: 'key', cluster: 'left', placement: {at: [24, 8, 0]}},
            c: {kind: 'key', part: 'key', cluster: 'right', placement: {at: [70, 0, 0]}}
        }
        input.designs.regions.keys.wrap = 'hull'
        const result = await engine.process(input, {analysis: true})
        const g = require('../../src/designs/geometry')
        const model = result.designs.features['profiles.board'].model
        assert.equal(g.chains(model).length, 2)
        assert.equal(require('makerjs').measure.isPointInsideModel([12, 4], model), true)
        assert.equal(require('makerjs').measure.isPointInsideModel([48, 4], model), false)
    })

    it('inherits footprint definitions while overriding instance references and parameters', () => {
        const input = fixture()
        input.parts.key.footprints = {switch: {what: 'mx', reference: 'S0', params: {from: 'COL', to: 'ROW'}, placement: {at: [1, 2, 0], rotate: 180}}}
        input.layout.objects.key.footprints = {switch: {reference: 'S1', params: {to: 'LOCAL'}}}
        const config = require('../../src/native/document').parse(input)
        const scene = require('../../src/native/layout').resolve(config)
        assert.deepEqual(scene.objects.key.footprints.switch, {
            what: 'mx', reference: 'S1', params: {from: 'COL', to: 'LOCAL'}, placement: {at: [1, 2, 0], rotate: 180}
        })
        input.layout.objects.key.footprints.switch = 'S2'
        const compact = require('../../src/native/document').parse(input)
        assert.equal(require('../../src/native/layout').resolve(compact).objects.key.footprints.switch.reference, 'S2')
        input.layout.objects.key.footprints.missing = {reference: 'X1'}
        assert.throws(() => require('../../src/native/layout').resolve(input), /Missing footprint provider/)
    })
})

it('uses flat bridge ends without growing past the attachment points', async () => {
    const input = fixture()
    input.layout.objects.second = {kind: 'key', part: 'key', placement: {at: [40, 0, 0]}}
    input.designs.profiles.board.bridges = {web: {from: {ref: 'key'}, to: {ref: 'second'}, width: 28, ends: 'flat'}}
    const result = await engine.process(input, {analysis: true})
    assert.equal(result.designs.features['profiles.board'].bounds.width, 58)
})

it('previews keycaps independently of switch bodies and PCB support', async () => {
    const input = fixture()
    input.parts.key.envelopes.keycap = {size: [18, 27]}
    const result = await engine.process(input, {debug: true})
    const bounds = require('makerjs').measure.modelExtents(result.demo.yaml)
    assert.equal(bounds.width,18)
    assert.equal(bounds.height,27)
    assert.deepEqual(result.layout.objects.key.envelopes.body.size,[14,14])
})

describe('Aligned outline bridges', () => {
    for (const align of ['top','bottom','left','right']) {
        it(`aligns a bridge to the shared ${align} edge and follows layout movement`, async () => {
            const input = fixture()
            const horizontal = ['top','bottom'].includes(align)
            input.layout.objects.second = {kind:'key',part:'key',placement:{at:horizontal?[40,4,0]:[4,40,0]}}
            input.designs.regions = {
                first:{select:{ids:['key']},envelope:'pcb'},
                second:{select:{ids:['second']},envelope:'pcb'}
            }
            input.designs.profiles.board = {from:['regions.first','regions.second'],connected:'single',bridges:{web:{from:{feature:'regions.first'},to:{feature:'regions.second'},align,width:6}}}
            const result = await engine.process(input,{analysis:true})
            const bounds = result.designs.features['profiles.board.bridges.web'].bounds
            const axis = horizontal ? 1 : 0
            const end = ['top','right'].includes(align) ? 'high' : 'low'
            assert.equal(bounds[end][axis],end==='high'?9:-5)
            input.layout.objects.key.placement = {at:[3,3,0]}
            input.layout.objects.second.placement.at = input.layout.objects.second.placement.at.map((v,i)=>i<2?v+3:v)
            const moved = await engine.process(input,{analysis:true})
            assert.equal(moved.designs.features['profiles.board.bridges.web'].bounds[end][axis],bounds[end][axis]+3)
        })
    }
})

it('reports off-board pad areas even when the owning key fits', async () => {
    const input = fixture()
    input.layout.objects.key.pcb = 'main'
    input.pcbs = {main:{profile:'profiles.board'}}
    input.layout.objects.key.footprints = {test:{what:'pad_edge_test',reference:'OFF1'}}
    engine.inject('footprint','pad_edge_test',{params:{},body:p=>`(footprint "test" (layer "F.Cu") ${p.at} (property "Reference" "${p.ref}") (pad "1" smd rect (at 8.5 0) (size 2 2) (layers "F.Cu")))`})
    const result = await engine.process(input,{analysis:true})
    const issue = result.layout.findings.find(f=>f.code==='pcb-pad-outside')
    assert.ok(issue,'Pad center fits but its edge must not leave the PCB')
    assert.match(issue.message,/OFF1/)
    assert.equal(issue.sourcePath,'layout.objects.key.footprints.test')
})

it('offers a rectangular component bay without boxing unrelated clusters', async () => {
    const input = fixture()
    input.layout.clusters = {bay:{arrangement:{type:'free'}}}
    input.layout.objects.key.cluster = 'bay'
    input.layout.objects.second = {kind:'key',part:'key',cluster:'bay',placement:{at:[24,8,0]}}
    input.designs.regions.keys.wrap = 'box'
    const result = await engine.process(input,{analysis:true})
    const model = result.designs.features['profiles.board'].model
    assert.ok(require('makerjs').measure.isPointInsideModel([-8,16],model))
    assert.equal(require('../../src/designs/geometry').paths(model).length,4)
})

it('checks custom polygon pad copper beyond its small anchor', async () => {
    const input = fixture()
    input.layout.objects.key.pcb = 'main'
    input.pcbs = {main:{profile:'profiles.board'}}
    input.layout.objects.key.footprints = {test:{what:'custom_pad_edge_test',reference:'CUSTOM1'}}
    engine.inject('footprint','custom_pad_edge_test',{params:{},body:p=>`(footprint "test" (layer "F.Cu") ${p.at} (property "Reference" "${p.ref}") (pad "1" smd custom (at 0 0) (size .1 .1) (layers "F.Cu") (options (anchor rect)) (primitives (gr_poly (pts (xy 0 0) (xy 10 0) (xy 10 1) (xy 0 1)) (width 0) (fill yes)))))`})
    const result = await engine.process(input,{analysis:true})
    assert.ok(result.layout.findings.some(f=>f.code==='pcb-pad-outside'&&f.message.includes('CUSTOM1')))
    assert.equal(result.layout.findings.filter(f=>f.code==='pcb-pad-geometry').length,0)
})
