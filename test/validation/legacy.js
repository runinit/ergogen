// Check historical PCB snapshots independently of the Mocha runner.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const yaml = require('js-yaml')
const ergogen = require('../../src/ergogen')
require('../helpers/mock').inject(ergogen)

;(async () => {
    let count = 0
    for (const category of ['footprints', 'pcbs']) {
        const directory = path.join(__dirname, '..', category)
        for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.yaml'))) {
            const input = yaml.load(fs.readFileSync(path.join(directory, file), 'utf8'))
            const result = await ergogen.process(input, true)
            const prefix = file.slice(0, -5) + '___pcbs_'
            for (const snapshot of fs.readdirSync(directory).filter(name => name.startsWith(prefix))) {
                const board = snapshot.slice(prefix.length, -'.kicad_pcb'.length)
                assert.equal(result.pcbs[board].replace(/\r\n/g, '\n'),
                    fs.readFileSync(path.join(directory, snapshot), 'utf8').replace(/\r\n/g, '\n'), snapshot)
                count++
            }
        }
    }
    console.log(`${count} legacy PCB snapshots passed`)
})().catch(error => {
    console.error(error)
    process.exitCode = 1
})
