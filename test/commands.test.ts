import { expect, setDefaultTimeout, test } from 'bun:test'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeCommandRunner } from '../src/commands.js'
import { ReleaseError } from '../src/errors.js'

setDefaultTimeout(15_000)

test('executes Windows command scripts without shell resolution errors', async () => {
  if (process.platform !== 'win32') return
  const result = await new NodeCommandRunner().run('npm.cmd', ['--version'], {
    cwd: process.cwd(),
  })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toMatch(/^\d+\./u)
})

test('aborting a shell command terminates its process tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-release-command-'))
  const marker = join(root, 'descendant-finished')
  await writeFile(
    join(root, 'parent.mjs'),
    `
    Bun.spawn([process.execPath, "./descendant.mjs"]);
    await Bun.sleep(10_000);
  `,
  )
  await writeFile(
    join(root, 'descendant.mjs'),
    `
    await Bun.sleep(1_000);
    await Bun.write(${JSON.stringify(marker)}, "finished");
  `,
  )
  const controller = new AbortController()
  const command = new NodeCommandRunner().shell('bun ./parent.mjs', {
    cwd: root,
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(new ReleaseError('interrupted', 130)), 200)

  try {
    expect((await command).exitCode).toBe(130)
    await Bun.sleep(1_300)
    expect(access(marker)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
