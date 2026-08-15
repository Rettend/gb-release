import type { CommandOptions, CommandResult, CommandRunner } from '../src/types.js'
import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkRegistryAuthentication } from '../src/auth.js'
import { FixedPrompt, MemoryLogger } from './helpers.js'

class UnauthenticatedRunner implements CommandRunner {
  readonly commands: string[] = []

  async run(command: string, args: string[], _options: CommandOptions): Promise<CommandResult> {
    this.commands.push([command, ...args].join(' '))
    return { command, exitCode: 1, stdout: '', stderr: 'not logged in' }
  }

  async shell(command: string, _options: CommandOptions): Promise<CommandResult> {
    throw new Error(`Unexpected shell command: ${command}`)
  }
}

class AuthenticatedRunner implements CommandRunner {
  args: string[] = []
  cwd = ''

  async run(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
    this.args = args
    this.cwd = options.cwd
    return { command, exitCode: 0, stdout: 'release-user\n', stderr: '' }
  }

  async shell(command: string, _options: CommandOptions): Promise<CommandResult> {
    throw new Error(`Unexpected shell command: ${command}`)
  }
}

test('checks npm authentication before allowing a publisher', async () => {
  const runner = new UnauthenticatedRunner()
  const prompt = new FixedPrompt('1.0.1', false)

  expect(
    checkRegistryAuthentication(['bun publish'], runner, prompt, new MemoryLogger(), process.cwd()),
  ).rejects.toThrow('npm authentication is required')
  expect(runner.commands.some(command => command.includes('whoami'))).toBe(true)
  expect(prompt.loginConfirmations).toBe(1)
})

test('checks the registry configured by an npm publish command', async () => {
  const runner = new AuthenticatedRunner()
  await checkRegistryAuthentication(
    ['npm --registry https://registry.example.com publish'],
    runner,
    new FixedPrompt(),
    new MemoryLogger(),
    process.cwd(),
  )

  expect(runner.args).toEqual(['whoami', '--registry', 'https://registry.example.com'])
})

test('authenticates in the selected npm workspace with its publish registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-release-auth-'))
  const workspace = join(root, 'packages', 'plugin')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
  await writeFile(
    join(workspace, 'package.json'),
    JSON.stringify({
      name: 'plugin',
      publishConfig: { registry: 'https://registry.example.com' },
    }),
  )
  const runner = new AuthenticatedRunner()

  try {
    await checkRegistryAuthentication(
      ['npm publish --workspace plugin'],
      runner,
      new FixedPrompt(),
      new MemoryLogger(),
      root,
    )
    expect(runner.cwd).toBe(workspace)
    expect(runner.args).toEqual(['whoami', '--registry', 'https://registry.example.com'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
