const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')
const ergogen = require('../../src/ergogen')
const prepare = require('../../src/prepare')

// Generate every built-in footprint fixture for independent KiCad load checks.
;(async () => {
    const output = process.argv[2]
    if (!output) {
        throw new Error('Usage: node test/validation/generate.js OUTPUT_DIRECTORY')
    }
    fs.mkdirSync(output, {recursive: true})
    const directory = path.join(__dirname, '..', 'footprints')
    for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.yaml'))) {
        const config = prepare.unnest(yaml.load(fs.readFileSync(path.join(directory, file), 'utf8')))
        for (const pcb of Object.values(config.pcbs)) {
            pcb.template = 'kicad10'
        }
        const result = await ergogen.process(config)
        for (const [name, board] of Object.entries(result.pcbs)) {
            fs.writeFileSync(path.join(output, `${file.slice(0, -5)}-${name}.kicad_pcb`), board)
        }
    }
})().catch(error => {
    console.error(error)
    process.exitCode = 1
})
