import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  Logger,
  ReleaseConfig,
  ReleasePrompt,
} from '../src/types.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expectSuccess, NodeCommandRunner } from '../src/commands.js'

export class FixedPrompt implements ReleasePrompt {
  selections = 0
  loginConfirmations = 0

  constructor(
    readonly version = '1.0.1',
    readonly login = false,
  ) {}

  async selectVersion(): Promise<string> {
    this.selections += 1
    return this.version
  }

  async confirmNpmLogin(): Promise<boolean> {
    this.loginConfirmations += 1
    return this.login
  }
}

export class MemoryLogger implements Logger {
  readonly infoMessages: string[] = []
  readonly warnings: string[] = []
  readonly errors: string[] = []

  info(message: string): void {
    this.infoMessages.push(message)
  }

  warn(message: string): void {
    this.warnings.push(message)
  }

  error(message: string): void {
    this.errors.push(message)
  }
}

export interface TestRepository {
  directory: string
  remote: string
  root: string
  runner: NodeCommandRunner
  cleanup(): Promise<void>
}

async function git(runner: CommandRunner, cwd: string, args: string[]): Promise<CommandResult> {
  return expectSuccess(await runner.run('git', args, { cwd }))
}

export async function createTestRepository(
  config: ReleaseConfig = {},
  files: Record<string, string> = {},
): Promise<TestRepository> {
  const directory = await mkdtemp(join(tmpdir(), 'gb-release-'))
  const remote = join(directory, 'remote.git')
  const root = join(directory, 'repository')
  const runner = new NodeCommandRunner()
  await mkdir(root)
  await git(runner, directory, ['init', '--bare', remote])
  await git(runner, directory, ['init', '--initial-branch=main', root])
  await git(runner, root, ['config', 'user.name', 'Release Test'])
  await git(runner, root, ['config', 'user.email', 'release@example.com'])

  const initialFiles: Record<string, string> = {
    'package.json': `${JSON.stringify({ name: 'test-package', version: '1.0.0' }, null, 2)}\n`,
    'release.config.ts': `export default ${JSON.stringify(config, null, 2)};\n`,
    '.gitignore': '*.log\n',
    ...files,
  }
  await Promise.all(
    Object.entries(initialFiles).map(async ([path, contents]) => {
      const absolutePath = join(root, path)
      const parent = absolutePath.slice(
        0,
        Math.max(absolutePath.lastIndexOf('/'), absolutePath.lastIndexOf('\\')),
      )
      if (parent && parent !== root) await mkdir(parent, { recursive: true })
      await writeFile(absolutePath, contents, 'utf8')
    }),
  )

  await git(runner, root, ['add', '.'])
  await git(runner, root, ['commit', '-m', 'Initial package'])
  await git(runner, root, ['remote', 'add', 'origin', remote])
  await git(runner, root, ['push', '--set-upstream', 'origin', 'main'])

  return {
    directory,
    remote,
    root,
    runner,
    async cleanup() {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 })
    },
  }
}

export async function packageVersion(path: string): Promise<string> {
  return (JSON.parse(await readFile(path, 'utf8')) as { version: string }).version
}

export class ButlerTestRunner implements CommandRunner {
  readonly commands: string[] = []

  constructor(
    private readonly delegate: CommandRunner,
    private readonly root: string,
    private readonly status: unknown = {
      uncommittedChanges: [],
      stacks: [{ branches: [{ name: 'work-in-progress' }] }],
    },
  ) {}

  async run(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
    this.commands.push([command, ...args].join(' '))
    if (command !== 'but') return await this.delegate.run(command, args, options)

    if (args[0] === 'status') {
      return {
        command: 'but status --json',
        exitCode: 0,
        stdout: JSON.stringify(this.status),
        stderr: '',
      }
    }
    if (args[0] === 'teardown') {
      return await this.delegate.run('git', ['switch', args[2] ?? 'main'], {
        cwd: this.root,
      })
    }
    if (args[0] === 'setup') {
      return await this.delegate.run('git', ['switch', 'gitbutler/workspace'], {
        cwd: this.root,
      })
    }
    if (args[0] === 'pull') return { command: 'but pull', exitCode: 0, stdout: '', stderr: '' }

    return {
      command: `but ${args.join(' ')}`,
      exitCode: 1,
      stdout: '',
      stderr: 'Unexpected but command',
    }
  }

  async shell(command: string, options: CommandOptions): Promise<CommandResult> {
    this.commands.push(command)
    return await this.delegate.shell(command, options)
  }
}
