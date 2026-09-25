import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import esbuild from 'rollup-plugin-esbuild'

const config = {
  input: 'src/index.ts',
  output: {
    esModule: true,
    file: 'dist/index.js',
    format: 'es',
    sourcemap: true,
    // @actions/glob's transitive deps call require() at runtime; an ESM bundle has no require, so
    // provide one from import.meta.url.
    banner: "import { createRequire as _createRequire } from 'module'; const require = _createRequire(import.meta.url);"
  },
  plugins: [
    esbuild({ target: 'es2022' }),
    nodeResolve({ preferBuiltins: true }),
    // transformMixedEsModules inlines deps that mix ESM exports with require() calls instead of
    // leaving a bare require behind.
    commonjs({ transformMixedEsModules: true }),
    json()
  ]
}

export default config
