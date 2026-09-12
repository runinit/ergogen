// Keep the public contract independent of compiler defaults and resolved state.
const dimension = {anyOf: [{type: 'number'}, {type: 'string', minLength: 1}]}
const text = {type: 'string', minLength: 1}
const vector = length => ({type: 'array', items: dimension, minItems: length, maxItems: length})
const mapping = schema => ({type: 'object', additionalProperties: schema})
const identities = schema => ({...mapping(schema), propertyNames: {pattern: '^[A-Za-z_][A-Za-z0-9_-]*$'}})
const object = (properties, required = []) => ({type: 'object', properties, required, additionalProperties: false})
const list = schema => ({type: 'array', items: schema})
const names = {anyOf: [text, list(text)]}
const placement = object({ref: text, at: vector(3), rotate: dimension, tilt: dimension, above: text, below: text, gap: dimension,
    solve: {type: 'array', items: {enum: ['x','y','rotate']}, uniqueItems: true},
    override: object({at: vector(3), rotate: dimension})})
const constraint = object({type: {enum: ['aligned','coincident','horizontal','vertical','distance','angle','equal_spacing','symmetric']},
    refs: {type: 'array', items: text, minItems: 2}, value: dimension, axis: {enum: ['x','y']}, label: text}, ['type','refs'])
const envelope = object({size: vector(2), radius: dimension, height: vector(2), at: vector(3), rotate: dimension,
    clearance: dimension, corner_radius: dimension, corner_relief: dimension, polygon: list(vector(2))})
const selector = object({kind: names, cluster: names, ids: list(text), pcb: text, layer: text})
const footprint = object({what: text, params: mapping({}), placement: object({at: vector(3), rotate: dimension}), reference: text}, ['what'])
const item = object({kind: {enum: ['key', 'component', 'mount', 'anchor']}, label: text, part: text, cluster: text, layer: text,
    placement, cell: {type: 'array', items: text, minItems: 2, maxItems: 2}, index: {type: 'integer', minimum: 0}, locked: {type: 'boolean'},
    pcb: text, side: {enum: ['top', 'bottom']}, properties: mapping({}), envelopes: mapping(envelope), attachments: mapping(placement),
    footprints: mapping({anyOf: [text, {...footprint, required: []}]}), models: list(mapping({}))}, ['kind'])
const shape = {...envelope, properties: {...envelope.properties, anchor: mapping({})}}
const modifications = mapping(object({...shape.properties, from: text, operation: {enum: ['add', 'subtract', 'intersect']}}))
const boundary = object({from: names, close: dimension, clearance: dimension, round: dimension, simplify: dimension,
    corners: {oneOf: [object({fillet: dimension}, ['fillet']), object({chamfer: dimension}, ['chamfer'])]},
    connected: {enum: ['single', 'multiple']}, modifications, bridges: mapping(object({from: mapping({}), to: mapping({}), width: dimension, ends: {enum: ['round','flat']}, align: {enum: ['top','bottom','left','right']}}, ['from', 'to', 'width'])),
    cutouts: list(text), gaps: list(text)})
const assemblyFields = ['preset','profile','plate_profile','pcb_profile','mounting','construction','supplier','board','manufacturing',
    'stackup','wall','floor','height','lid','plate','plate_z','pcb_z','pcb_thickness','bezel','fit','internal_radius','opening','openings','components',
    'cutouts','mounts','gaskets','gasket','ledge','seam','typing_angle','front_height','fillet','chamfer','mount_count','spacing','layers','thickness','clearance']
module.exports = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://runinit.github.io/ergogen/schema/ergogen-v1.json',
    ...object({schema: {const: 'ergogen/v1'}, meta: mapping({}), units: mapping(dimension),
        parts: identities(object({revision: text, envelopes: mapping(envelope), attachments: mapping(placement), footprints: mapping(footprint), models: list(mapping({}))}, ['revision'])),
        layout: object({objects: identities(item), constraints: identities(constraint), layers: identities(object({surface: text, placement, assembly: text, motion: {enum: ['fixed','floating']}})),
            clusters: identities(object({label: text, layer: text, placement, locked: {type: 'boolean'},
                arrangement: object({type: {enum: ['free','columns','arc']}, pitch: vector(2), columns: list(text), rows: list(text), stagger: mapping(dimension), splay: mapping(dimension), offsets: mapping(vector(3)), radius: dimension, start: dimension, step: dimension}, ['type']),
                mirror: object({source: text, axis: dimension}, ['source','axis']), overrides: mapping({...item, required: []})}))}),
        designs: object({stackups: identities(object({pcb:text,plate:object({thickness:dimension,gap:dimension}),layers:identities(object({label:text,material:{enum:['foam','silicone','gasket']},lower:text,upper:text,thickness:dimension,compression:dimension,inset:dimension,clearance:dimension,profile:text,cutouts:list(text)},['material','lower','upper','thickness']))},['pcb'])),regions: mapping(object({select: selector, envelope: text, wrap: {enum: ['tight','hull','box']}, shape, close: dimension, clearance: dimension, round: dimension,
            connected: {enum: ['single','multiple']}, modifications})), boundaries: mapping(boundary), profiles: mapping(boundary),
            sketches: mapping(mapping({})), assemblies: mapping(object(Object.fromEntries(assemblyFields.map(key => [key, {}]))))}),
        pcbs: identities(object({profile: text, thickness: dimension, placement, references: {type: 'boolean'}, params: mapping({}), source: {enum:['asset']}, asset: text}, []))
    }, ['schema','layout']),
    $defs: {placement, envelope, selector, object: item}
}
