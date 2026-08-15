import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test('loads TypeScript configuration and applies defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-release-config-'))
  directories.push(root)
  await writeFile(join(root, 'package.json'), '{"version":"1.0.0"}')
  await writeFile(
    join(root, 'release.config.ts'),
    `
    export default {
      prepare: "bun run build",
      publish: ["bun publish"],
      commitFiles: [],
    };
  `,
  )

  expect(await loadConfig(root)).toEqual({
    target: { remote: 'origin', branch: 'main' },
    versionFiles: ['package.json'],
    prepare: ['bun run build'],
    publish: ['bun publish'],
    commitFiles: [],
    commitMessage: 'chore: release v%s',
    tagName: 'v%s',
  })
})

test('rejects version files outside the repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-release-config-'))
  directories.push(root)
  await writeFile(
    join(root, 'release.config.ts'),
    'export default { versionFiles: ["../package.json"] };',
  )

  expect(loadConfig(root)).rejects.toThrow('outside the repository')
})
