const {parseDocument, LineCounter} = require('yaml')
const validate = require('./validate')
const g = require('../designs/geometry')

const parse = raw => {
    let value = raw, document, counter
    if (typeof raw === 'string') {
        counter = new LineCounter()
        document = parseDocument(raw, {keepSourceTokens: true, lineCounter: counter, uniqueKeys: true})
        if (document.errors.length) {
            const error = document.errors[0]
            g.fail('schema', error.message, 'schema')
        }
        value = document.toJS({maxAliasCount: 100})
    }
    if (!value || value.schema !== 'ergogen/v1') {
        g.fail('schema', 'This engine accepts schema: ergogen/v1 only. Preserve the original document and author a native configuration.', 'schema')
    }
    if (!validate(value)) {
        const errors = validate.errors.map(error => {
            const path = error.instancePath.split('/').slice(1).map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'))
            const key = error.params.additionalProperty || error.params.missingProperty
            if (key) { path.push(key) }
            const node = document?.getIn(path, true)
            const feature = path.join('.') || 'schema'
            return {feature, sourcePath: feature, code: 'schema', severity: 'error', message: `${feature}: ${error.message}`,
                ...(node?.range ? {location: counter.linePos(node.range[0])} : {})}
        })
        const error = new Error(errors.map(item => item.message).join('\n'))
        error.diagnostics = errors
        throw error
    }
    return require('./stackups').linked(JSON.parse(JSON.stringify(value)))
}
const locate = (raw, findings) => {
    if (typeof raw !== 'string' || !findings?.length) { return }
    const counter = new LineCounter()
    const doc = parseDocument(raw,{lineCounter:counter})
    for (const finding of findings) {
        if (finding.location) { continue }
        const path=(finding.sourcePath || finding.feature || 'schema').split('.')
        let node=doc.getIn(path,true)
        while (!node?.range && path.length) { path.pop(); node=doc.getIn(path,true) }
        if (node?.range) { finding.location=counter.linePos(node.range[0]) }
    }
}
module.exports = {parse,locate}
