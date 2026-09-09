const assert = require('node:assert/strict')
const vm = require('node:vm')
const tools = require('../helpers/adapter-engine').footprints
const sexpr = require('../../src/templates/sexpr')
const inventory = require('../../src/designs/board-inventory')

const sample = `(footprint "Device:Quoted \\"name\\"" (version 20260206) (layer "F.Cu")
    (property "Reference" "REF**" (at 0 -3) (layer "F.SilkS"))
    (property "Value" "a (b)" (at 0 3 20) (layer "F.Fab"))
    (private_metadata "keep me")
    (fp_rect (start -2 -2) (end 2 2) (stroke (width 0.1) (type default)) (fill none) (layer "F.CrtYd"))
    (pad "1" smd roundrect (at 2 3 30) (size 1 2) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.2))
    (pad "1" thru_hole oval (at -2 3 10) (size 2 3) (drill oval 1 2 (offset 0.1 0.2)) (layers "*.Cu" "*.Mask"))
    (pad "" np_thru_hole circle (at 0 1) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask"))
    (model "original.step" (offset (xyz 0 0 1)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))`
const binding = path => ({path, offset:[1,2,3], rotate:[10,20,30], scale:[1,2,1]})
const evaluate = source => {
    const scope = {module:{exports:{}}}
    vm.runInNewContext(source, scope)
    return scope.module.exports
}
const nodes = (root, name) => root.filter(n => Array.isArray(n) && n[0] === name)

describe('Reusable footprint tools', () => {
    it('derives one envelope from all transformed cached models and keeps missing bounds unchecked', () => {
        const model = {path:'${KIPRJMOD}/models/hash/a.step',offset:[3,4,5],rotate:[0,0,90],scale:[2,1,1]}
        const assets = {'__model_hash/a.step.json':JSON.stringify({bounds:[[0,0,0],[2,1,3]]})}
        const envelope = tools.envelope([model,{...model,offset:[10,4,5]}],assets)
        assert.ok(Math.abs(envelope.size[0]-8)<0.000001)
        assert.ok(Math.abs(envelope.size[1]-4)<0.000001)
        assert.deepEqual(envelope.height,[5,8])
        assert.equal(tools.envelope([model,{...model,path:'missing.step'}],assets),null)
    })
    it('groups electrical pads by number and leaves mechanical pads separate', () => {
        const data = tools.inspect(sample)
        assert.equal(data.pads.length, 3)
        assert.deepEqual(data.nets, [{number:'1', parameter:'pad_1', pads:[0,1]}])
        assert.equal(data.models[0].path, 'original.step')
        assert.ok(data.diagnostics.some(d => d.code === 'metadata'))
    })

    it('exports a standalone CommonJS module preserving geometry and mapped nets', () => {
        const converted = tools.convert(sample, {name:'imported', mapping:{'1':'signal'}})
        const module = evaluate(converted.source)
        assert.equal(module.params.signal.type, 'net')
        assert.equal(module.params.designator.type, 'string')
        const output = module.body({x:12,y:14,r:90,ref:'U3',side:'F',signal:{index:5,name:'quoted "net"'}})
        const root = sexpr.parse(output)[0]
        assert.ok(root.findIndex(node => node[0] === 'at') < root.findIndex(node => node[0] === 'pad'), 'KiCad reads placement before child pad orientations')
        const pads = nodes(root,'pad')
        assert.deepEqual(nodes(root,'at')[0].slice(1), ['12','14','90'])
        assert.deepEqual(nodes(pads[0],'at')[0].slice(1), ['2','3','120'])
        assert.equal(nodes(pads[0],'net')[0][2], '"quoted \\"net\\""')
        assert.equal(sexpr.print(nodes(pads[0],'net')[0]), sexpr.print(nodes(pads[1],'net')[0]))
        assert.equal(nodes(pads[2],'net').length, 0)
        assert.ok(output.includes('(private_metadata "keep me")'))
        assert.ok(output.includes('(drill oval 1 2 (offset 0.1 0.2))'))
        assert.ok(converted.yaml.includes('signal:'))
    })

    it('flips board layers, local coordinates and pad orientations on the back', () => {
        const module = evaluate(tools.convert(sample).source)
        const root = sexpr.parse(module.body({x:0,y:0,r:90,ref:'U1',side:'B',pad_1:{index:1,name:'GND'}}))[0]
        const pad = nodes(root,'pad')[0]
        assert.equal(nodes(root,'layer')[0][1], '"B.Cu"')
        assert.deepEqual(nodes(pad,'at')[0].slice(1), ['2','-3','60'])
        assert.deepEqual(nodes(pad,'layers')[0].slice(1), ['"B.Cu"','"B.Paste"','"B.Mask"'])
    })

    it('keeps unknown constructs but refuses unsafe transforms explicitly', () => {
        const input = sample.replace('(private_metadata "keep me")','(fp_future_curve (xyz 1 2 3))')
        const converted = tools.convert(input)
        assert.ok(converted.diagnostics.some(d => d.code === 'unsupported-geometry'))
        const module = evaluate(converted.source)
        assert.throws(() => module.body({x:1,y:0,r:10,side:'B'}), /Unsupported.*fp_future_curve/)
    })

    it('requires a unique target and preserves all unrelated bytes when binding models', () => {
        const source = sample + '\n' + sample.replace('REF**','J1') + '\n(segment (net 3))'
        assert.throws(() => tools.models(source,[binding('a.step')]), /target/i)
        const result = tools.models(source,[binding('a.step'),binding('b.wrl')],{reference:'J1'})
        assert.ok(result.startsWith(sample + '\n'))
        assert.ok(result.endsWith('\n(segment (net 3))'))
        assert.equal((result.match(/\(model /g)||[]).length,3)
        assert.ok(result.includes('(pad "1" smd roundrect'))
        assert.throws(() => tools.models(sample,[binding('a.step')],{reference:'missing'}),/target/i)
    })

    it('identifies a chosen emission independently of per-placement references', () => {
        const source = sample + '\n' + sample.replace('REF**','U99')
        const target = tools.inspect(source).targets[1]
        assert.equal(target.index,1)
        const selection = {name:target.name,index:target.index,count:target.count}
        const result = tools.models(source,[binding('selected.step')],selection)
        assert.ok(result.startsWith(sample))
        assert.equal(tools.inspect(source,selection).pads.length,3)
        assert.throws(() => tools.models(sample,[binding('selected.step')],selection),/target/i)
    })

    it('updates multiple models on a routed board and accepts legacy single bindings', () => {
        const source = `(kicad_pcb ${sample} (segment (start 1 2) (end 3 4) (net 1)))`
        const result = inventory.associate(source,'REF**',[binding('a.step'),binding('b.step')])
        assert.equal((result.match(/\(model /g)||[]).length,2)
        assert.ok(result.endsWith(' (segment (start 1 2) (end 3 4) (net 1)))'))
        assert.equal((inventory.associate(result,'REF**',binding('c.step')).match(/\(model /g)||[]).length,1)
        assert.ok(!inventory.associate(result,'REF**',[]).includes('(model '))
    })

    it('wraps dynamic modules without changing their params, body branches or unrelated code', () => {
        const original = '// retain this comment\nmodule.exports = {params:{count:2}, body:p => `(footprint "Dynamic" (layer "F.Cu") (pad "${p.count}" smd circle (at 0 0) (size 1 1) (layers "F.Cu")))`}'
        const source = tools.bind(original,[binding('case.step')])
        assert.ok(source.includes(original))
        const module = evaluate(source)
        assert.equal(module.params.count,2)
        const result = module.body({count:7})
        assert.ok(result.includes('(pad "7"'))
        assert.ok(result.includes('(model "case.step"'))
    })
})

it('assigns distinct stable KiCad identities to repeated imported placements', () => {
    const source = sample.replace('(layer "F.Cu")','(layer "F.Cu") (uuid "23a1b833-bf14-4d74-b5dd-5a40380723ab")');
    const module = evaluate(tools.convert(source).source);
    const p = {x:0,y:0,r:0,side:'F',pad_1:{index:1,name:'GND'}};
    const id = ref => nodes(sexpr.parse(module.body({...p,ref}))[0],'uuid')[0][1];
    assert.notEqual(id('U1'),id('U2'));
    assert.equal(id('U1'),id('U1'));
});
it('supports declarative model bindings through the existing injection API', async () => {
    const ergogen = require('../helpers/adapter-engine');
    const module = evaluate(tools.convert(sample).source);
    module.modelBindings = p => ({models:[binding(`${p.ref}.step`),binding('second.step')]});
    ergogen.inject('footprint','declarative_test',module);
    const result = await ergogen.process({points:{zones:{one:{}}},pcbs:{board:{footprints:{part:{what:'declarative_test',where:true,params:{pad_1:'GND'}}}}}},{debug:true});
    assert.ok(result.pcbs.board.includes('(model "U1.step"'));
    assert.ok(result.pcbs.board.includes('(model "second.step"'));
});
it('counts native part bindings and explicit instances', () => {
    const source = {schema:'ergogen/v1',parts:{switch:{revision:'1',footprints:{base:{what:'linked'}}}},layout:{objects:{one:{kind:'key',part:'switch',pcb:'board'},two:{kind:'key',part:'switch',pcb:'board'}}},pcbs:{board:{}}};
    assert.equal(tools.countUses(source,'linked'),2);
    assert.equal(tools.countUses(source,'missing'),0);
});
it('converts legacy inch model offsets and preserves additional model metadata', () => {
    const source = '(footprint "legacy" (layer "F.Cu") (model "x.step" (at (xyz 1 2 3)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)) (opacity 0.5)))';
    const model = tools.inspect(source).models[0];
    assert.deepEqual(model.offset,[25.4,50.8,76.19999999999999]);
    const updated = tools.models(source,[{...model,offset:[0,0,1]}]);
    assert.ok(updated.includes('(opacity 0.5)'));
    assert.ok(updated.includes('(offset (xyz 0 0 1))'));
});
