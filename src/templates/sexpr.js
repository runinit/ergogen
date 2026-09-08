// Keep quoted atoms distinct so net "123" never becomes numeric net 123.
exports.quote = value => JSON.stringify(String(value))
exports.parse = (source, context) => {
    const roots = []
    const stack = [roots]
    const tokens = /\s+|;[^\n]*|\(|\)|"(?:\\.|[^"\\])*"|[^\s()"]+/gy
    let offset = 0
    while (offset < source.length) {
        tokens.lastIndex = offset
        const match = tokens.exec(source)
        if (!match) {
            throw new Error(`${context}: invalid S-expression at character ${offset}`)
        }
        const token = match[0]
        offset = tokens.lastIndex
        if (/^\s|^;/.test(token)) {
            continue
        }
        if (token === '(') {
            const node = []
            node.range = [offset - 1, null]
            stack[stack.length - 1].push(node)
            stack.push(node)
        } else if (token === ')') {
            if (stack.length === 1) {
                throw new Error(`${context}: unexpected closing parenthesis at ${offset}`)
            }
            stack[stack.length - 1].range[1] = offset
            stack.pop()
        } else {
            stack[stack.length - 1].push(token)
        }
    }
    if (stack.length !== 1 || roots.some(node => !Array.isArray(node))) {
        throw new Error(`${context}: incomplete S-expression`)
    }
    return roots
}
exports.print = node => Array.isArray(node) ? `(${node.map(exports.print).join(' ')})` : node
exports.value = atom => atom.startsWith('"') ? JSON.parse(atom) : atom
