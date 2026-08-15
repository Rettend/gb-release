import { defineConfig } from './src/index.ts'

export default defineConfig({
  versionFiles: ['package.json'],
  prepare: 'bun run check && bun test && bun run build',
  publish: 'bun publish',
})
