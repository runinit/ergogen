import pkg from './package.json' with { type: 'json' }
import json from '@rollup/plugin-json'
import commonjs from '@rollup/plugin-commonjs'
import {nodeResolve} from '@rollup/plugin-node-resolve'

export default {
  input: 'src/ergogen.js',
  external: ['makerjs', 'js-yaml', 'mathjs', 'kle-serial', 'jszip', 'hull', '@salusoft89/planegcs', 'replicad', 'replicad-opencascadejs'],
  output: {
    name: 'ergogen',
    file: 'dist/ergogen.js',
    format: 'umd',
    banner: `/*!\n * Ergogen v${pkg.version}\n * https://ergogen.xyz\n */\n`,
    globals: {
      'makerjs': 'makerjs',
      'js-yaml': 'jsyaml',
      'mathjs': 'math',
      'kle-serial': 'kle',
      'jszip': 'jszip',
      'hull': 'hull'
    }
  },
  plugins: [
    nodeResolve({preferBuiltins: true}),
    json(),
    commonjs()
  ]
}