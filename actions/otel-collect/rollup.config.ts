import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

const config = {
  input: 'src/index.ts',
  output: {
    esModule: true,
    file: 'dist/index.js',
    format: 'es',
    sourcemap: true,
    // Some bundled deps (otlp exporters, @grpc/grpc-js) call require() at runtime;
    // an ESM bundle has no require, so provide one from import.meta.url.
    banner: "import { createRequire as _createRequire } from 'module'; const require = _createRequire(import.meta.url);"
  },
  plugins: [
    typescript(),
    nodeResolve({ preferBuiltins: true }),
    // transformMixedEsModules inlines deps that mix ESM exports with require() calls
    // (e.g. @opentelemetry/otlp-exporter-base) instead of leaving a bare require.
    commonjs({ transformMixedEsModules: true }),
    json()
  ]
}

export default config
