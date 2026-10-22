import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.ts', 'src/restore-cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // one self-contained file: workspace packages are TypeScript sources, npm deps are pure JS
  noExternal: [/.*/],
  external: ['pg-native'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
})
