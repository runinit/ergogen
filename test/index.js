const fs = require('fs-extra')
const path = require('path')
const yaml = require('js-yaml')
const glob = require('glob')
const u = require('../src/utils')
const a = require('../src/assert')
const ergogen = require('./helpers/adapter-engine')
require('./helpers/mock').inject(ergogen)

let what = process.env.npm_config_what
const dump = process.env.npm_config_dump
const lineends = require('./helpers/fixture').lineends

const handle_slash = (() => {
  if (path.sep == '\\') {
    return str => str.replace(/\\/g,'/')
  } else {
    return str => str
  }
})()


// Unit tests
// the --what switch supports each unit individually
// the --dump switch does nothing here

what = what ? what.split(',') : false
for (const unit of glob.sync(handle_slash(path.join(__dirname, 'unit', '*.js')))) {
    const base = path.basename(unit, '.js')
    if (what && !what.includes(base)) continue
    require(`./unit/${base}.js`)
}



// Integration tests
// the --what switch supports categories (like `points` and `outlines`)
// as well as individual tests using slash-notation (like `points/default`)
// the --dump switch can output the new results, overriding the old reference

const dump_structure = (obj, depth=-1, prefix='', breadcrumbs=[]) => {
    if (a.type(obj)() != 'object') {
        console.log(prefix + breadcrumbs.join('_'))
        return
    }
    if (depth == 0) return
    for (const [key, val] of Object.entries(obj)) {
        breadcrumbs.push(key)
        dump_structure(val, depth-1, prefix, breadcrumbs)
        breadcrumbs.pop()
    }
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1)

const test = function(input_path) {
    this.timeout(120000)
    this.slow(120000)
    title = path.basename(input_path, '.yaml').split('_').join(' ')
    it(title, async function() {
        
        const input = yaml.load(fs.readFileSync(input_path).toString())
        const base = path.join(path.dirname(input_path), path.basename(input_path, '.yaml'))
        const references = glob.sync(handle_slash(base) + '___*')
        
        // handle deliberately wrong inputs
        const exception = base + '___EXCEPTION.txt'
        if (fs.existsSync(exception)) {
            const exception_snippet = fs.readFileSync(exception).toString()
            return await ergogen.process(input, true).should.be.rejectedWith(exception_snippet)
        }

        const output = await ergogen.process(input, true)

        // compare output vs. reference
        if (references.length) {
            for (const expected_path of references) {
                let expected = fs.readFileSync(expected_path).toString()
                if (expected_path.endsWith('.json')) {
                    expected = JSON.parse(expected)
                }
                const comp_path = expected_path.split('___')[1].split('.')[0].split('_').join('.')
                const output_part = u.deep(output, comp_path)
                if (dump) {
                    if (a.type(output_part)() == 'string') {
                        fs.writeFileSync(expected_path, output_part)
                    } else {
                        fs.writeJSONSync(expected_path, output_part, {spaces: 4})
                    }
                } else {
                    if (a.type(output_part)() == 'string') {
                        const parse_out = output_part.replace(lineends, '\n').replace(/\(generator_version \"[^\"]+\"\)/g, '(generator_version \"<version>\")')
                        const parse_exp = expected.replace(lineends, '\n').replace(/\(generator_version \"[^\"]+\"\)/g, '(generator_version \"<version>\")')
                        parse_out.should.deep.equal(parse_exp)
                    } else {
                        // JSON can hide negative zeroes, for example, so we canonical-ize first
                        const canonical_part = JSON.parse(JSON.stringify(output_part))
                        canonical_part.should.deep.equal(expected)
                    }
                }
            }

        // explicit dump-ing above only works, if there are already files with the right name
        // if there aren't, dump now outputs a list of candidates that could be referenced
        } else if (dump) {
            dump_structure(output, 3, base + '___')
        }
    })
}

if (what) {
    for (const w of what) {
        let regex
        let title
        if (w.includes('/')) {
            title = cap(w.split('/')[0]) + ' (partial)'
            regex = path.join(__dirname, w + '*.yaml')
        } else {
            title = cap(w)
            regex = path.join(__dirname, w, '*.yaml')
        }
        describe(title, function() {
            for (const i of glob.sync(handle_slash(regex))) {
                test.call(this, i)
            }
        })
    }
} else {
    for (const part of ['points', 'outlines', 'cases', 'pcbs', 'footprints']) {
        describe(cap(part), function() {
            for (const i of glob.sync(handle_slash(path.join(__dirname, part, '*.yaml')))) {
                test.call(this, i)
            }
        })
    }
}



// Native CLI coverage is in unit/native_cli.js. Historical CLI snapshots remain archival.
