const assert = require('node:assert/strict')
const {describe, it} = global.describe ? global : require('node:test')
const ergogen = require('../helpers/adapter-engine')

const config = template => ({
    points: {zones: {key: {}}},
    pcbs: {board: {...(template ? {template} : {})}}
})

describe('KiCad 10', () => {
    it('defaults to native KiCad 10 and supports explicit selection', async () => {
        for (const template of [undefined, 'kicad10']) {
            const result = await ergogen.process(config(template))
            assert.match(result.pcbs.board, /\(version 20260206\)/)
            assert.match(result.pcbs.board, /\(2 "B.Cu" signal\)/)
        }
    })

    it('preserves explicit legacy and injected templates', async () => {
        for (const [template, version] of [['kicad5', 20171130], ['kicad8', 20240108]]) {
            const result = await ergogen.process(config(template))
            assert.match(result.pcbs.board, new RegExp(`\\(version ${version}\\)`))
        }
        ergogen.inject('template', 'test_custom', {body: () => 'custom'})
        assert.equal((await ergogen.process(config('test_custom'))).pcbs.board, 'custom')
    })

    it('normalizes routed copper and preserves numeric-looking names', async () => {
        ergogen.inject('footprint', 'test_copper', {
            params: {signal: {type: 'net', value: '123'}},
            body: p => `(module test (layer F.Cu) ${p.at}
                (pad 1 thru_hole circle (at 0 0) (size 2 2) (drill 1) (layers *.Cu *.Mask) ${p.signal})
                (pad 2 thru_hole circle (at 3 0) (size 2 2) (drill 1) (layers *.Cu *.Mask) ${p.local_net('local')}))
                (segment (start 0 0) (end 3 0) (width 0.25) (layer F.Cu) (net ${p.signal.index}))
                (via (at 3 0) (size 0.8) (drill 0.4) (layers F.Cu B.Cu) (net ${p.signal.index}))`
        })
        const input = config()
        input.pcbs.board.footprints = {copper: {what: 'test_copper'}}
        const board = (await ergogen.process(input)).pcbs.board
        assert.equal((board.match(/\(net "123"\)/g) || []).length, 3)
        assert.match(board, /\(net ".*_local"\)/)
        assert.match(board, /\(footprint test/)
    })

    it('orders legacy arc coordinates for the native parser', () => {
        const template = require('../../src/templates/kicad10')
        const board = template.body({name: 'arc', version: '1', author: '', nets: [], outlines: {},
            footprints: ['(module arc (layer F.Cu) (fp_arc (start 0 0) (end 1 0) (angle 90) (layer Edge.Cuts) (width 0.15)))']})
        assert.match(board, /\(fp_arc \(start 1 0\) \(mid [^)]+\) \(end [^)]+\)/)
    })

    it('escapes net and board names and keeps empty nets', async () => {
        const name = 'signal "quoted" \\ return\nline'
        ergogen.inject('footprint', 'test_names', {
            params: {signal: {type: 'net', value: name}, empty: {type: 'net', value: ''}},
            body: p => `(footprint names (layer F.Cu) (pad 1 smd rect (at 0 0) (size 1 1) (layers F.Cu) ${p.signal}) (pad 2 smd rect (at 2 0) (size 1 1) (layers F.Cu) ${p.empty}))`
        })
        const input = config()
        input.pcbs.board.footprints = {names: {what: 'test_names'}}
        input.meta = {author: name}
        const board = (await ergogen.process(input)).pcbs.board
        assert.ok(board.includes(`(net ${JSON.stringify(name)})`))
        assert.ok(board.includes(`(company ${JSON.stringify(name)})`))
        assert.ok(board.includes('(net "")'))
    })

    it('normalizes zones and leaves native quoted net names intact', () => {
        const template = require('../../src/templates/kicad10')
        const board = template.body({name: 'zones', version: '1', author: '',
            nets: [{index: 1, name: 'GND'}], outlines: {}, footprints: [
                '(zone (net 1) (net_name "GND") (layer F.Cu)) (segment (net "123"))'
            ]})
        assert.ok(board.includes('(zone (net "GND") (layer F.Cu))'))
        assert.ok(board.includes('(segment (net "123"))'))
        assert.ok(!board.includes('net_name'))
    })

    it('rejects malformed fragments and mismatched net names', () => {
        const template = require('../../src/templates/kicad10')
        const params = {name: 'invalid', version: '1', author: '',
            nets: [{index: 1, name: 'GND'}], outlines: {}}
        for (const fragment of ['(pad', ')', '(net 1 "wrong")', '(net)']) {
            assert.throws(() => template.body({...params, footprints: [fragment]}), /PCB invalid/)
        }
    })

    it('continues to reject engine 4 configurations', async () => {
        await assert.rejects(ergogen.process({...config(), meta: {engine: '4.1.0'}}), /engine requirement/)
    })

    it('rejects unknown numeric references with board and fragment context', async () => {
        ergogen.inject('footprint', 'test_bad_net', {params: {}, body: () => '(segment (net 99))'})
        const input = config()
        input.pcbs.board.footprints = {bad: {what: 'test_bad_net'}}
        await assert.rejects(ergogen.process(input), /board.*footprint.*99/)
    })
})
