const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {spawnSync} = require('node:child_process')

describe('Native CLI', function() {
    this.timeout(30000)
    it('exports native geometry and rejects a legacy document without changing existing output', () => {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(),'ergogen-native-'))
        try {
            const output=path.join(temp,'output')
            const result=spawnSync(process.execPath,['src/cli.js','docs/examples/native/columns.yaml','-o',output,'--svg','--debug'],{encoding:'utf8'})
            assert.equal(result.status,0,result.stderr)
            assert.ok(fs.existsSync(path.join(output,'pcbs','main.kicad_pcb')))
            const original=fs.readFileSync(path.join(output,'pcbs','main.kicad_pcb'))
            const legacy=path.join(temp,'legacy.yaml'); fs.writeFileSync(legacy,'points: {zones: {key: {}}}')
            const rejected=spawnSync(process.execPath,['src/cli.js',legacy,'-o',output,'--clean'],{encoding:'utf8'})
            assert.notEqual(rejected.status,0)
            assert.match(rejected.stderr,/schema: ergogen\/v1/)
            assert.deepEqual(fs.readFileSync(path.join(output,'pcbs','main.kicad_pcb')),original)
        } finally { fs.rmSync(temp,{recursive:true,force:true}) }
    })
})
