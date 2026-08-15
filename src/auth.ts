import type { CommandRunner, Logger, ReleasePrompt } from './types.js'
import { readFile, readdir } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { expectSuccess } from './commands.js'
import { ReleaseError } from './errors.js'

interface PackageManifest {
  name?: string
  publishConfig?: {
    registry?: string
  }
  workspaces?:
    | string[]
    | {
        packages?: string[]
      }
}

interface NpmPublisher {
  cwd: string
  registry?: string
}

function shellTokens(command: string): string[] {
  return (command.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/gu) ?? []).map(token =>
    token.replace(/^(["'])|(["'])$/gu, ''),
  )
}

function optionValue(tokens: string[], name: string): string | undefined {
  const index = tokens.indexOf(name)
  if (index >= 0) return tokens[index + 1]
  return tokens.find(token => token.startsWith(`${name}=`))?.slice(name.length + 1)
}

function hasOption(tokens: string[], name: string): boolean {
  return tokens.includes(name) || tokens.some(token => token.startsWith(`${name}=`))
}

function repositoryPath(root: string, path: string, field: string): string {
  const absolutePath = resolve(root, path)
  const relativePath = relative(root, absolutePath)
  if (
    isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    relativePath.startsWith('..\\')
  )
    throw new ReleaseError(`${field} points outside the repository: ${path}`)

  return absolutePath
}

function validateRegistry(registry: string): string {
  try {
    const url = new URL(registry)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error()
    if (/[\s&|<>^%!"']/u.test(registry)) throw new Error()
  } catch {
    throw new ReleaseError(`Invalid npm registry URL in publish command: ${registry}`)
  }
  return registry
}

async function readManifest(directory: string): Promise<PackageManifest | undefined> {
  try {
    return JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')) as PackageManifest
  } catch {
    return undefined
  }
}

async function resolveWorkspace(root: string, workspace: string): Promise<string> {
  const rootManifest = await readManifest(root)
  const patterns = Array.isArray(rootManifest?.workspaces)
    ? rootManifest.workspaces
    : (rootManifest?.workspaces?.packages ?? [])
  const directories: string[] = []

  for (const pattern of patterns) {
    const normalized = pattern.replaceAll('\\', '/').replace(/\/$/u, '')
    if (!normalized.includes('*')) {
      directories.push(repositoryPath(root, normalized, 'workspace'))
      continue
    }
    if (!normalized.endsWith('/*') || normalized.slice(0, -2).includes('*')) {
      throw new ReleaseError(
        `Cannot resolve workspace pattern "${pattern}" for authentication. Use a publish command with --cwd.`,
      )
    }
    const parent = repositoryPath(root, normalized.slice(0, -2), 'workspace')
    let entries
    try {
      entries = await readdir(parent, { withFileTypes: true })
    } catch {
      continue
    }
    directories.push(
      ...entries.filter(entry => entry.isDirectory()).map(entry => resolve(parent, entry.name)),
    )
  }

  for (const directory of directories) {
    const manifest = await readManifest(directory)
    const relativeDirectory = relative(root, directory).replaceAll('\\', '/')
    if (
      manifest?.name === workspace ||
      relativeDirectory === workspace ||
      basename(directory) === workspace
    )
      return directory
  }
  throw new ReleaseError(`Could not resolve npm workspace for authentication: ${workspace}`)
}

function isRegistryPublish(tokens: string[]): boolean {
  if (tokens[0] !== 'npm' && tokens[0] !== 'bun') return false
  if (tokens[1] === 'run' || tokens[1] === 'exec' || tokens[1] === 'x') return false
  return tokens.includes('publish')
}

async function npmPublishers(
  commands: string[],
  root: string,
  runner: CommandRunner,
  signal?: AbortSignal,
): Promise<NpmPublisher[]> {
  const publishers: NpmPublisher[] = []
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

  for (const command of commands) {
    if (/\|\||[;|]/u.test(command)) {
      const tokens = shellTokens(command)
      if (tokens.includes('publish') && (tokens.includes('npm') || tokens.includes('bun'))) {
        throw new ReleaseError(
          "npm publish commands using ';', '|', or '||' cannot be authenticated safely. Configure a direct command or use --cwd.",
        )
      }
    }

    let activeDirectory = root
    for (const segment of command.split('&&')) {
      const tokens = shellTokens(segment.trim())
      if (tokens[0] === 'cd') {
        if (!tokens[1] || tokens.length !== 2) {
          throw new ReleaseError(
            'Use `cd <directory> && npm publish` or configure the publisher with --cwd.',
          )
        }

        activeDirectory = repositoryPath(root, tokens[1], 'publish cwd')
        continue
      }
      if (!isRegistryPublish(tokens)) continue

      const cwdOption = optionValue(tokens, '--cwd')
      const prefixOption = optionValue(tokens, '--prefix')
      const workspace = optionValue(tokens, '--workspace') ?? optionValue(tokens, '-w')
      if (hasOption(tokens, '--cwd') && !cwdOption)
        throw new ReleaseError('Publish option --cwd requires a path.')
      if (hasOption(tokens, '--prefix') && !prefixOption)
        throw new ReleaseError('Publish option --prefix requires a path.')
      if ((hasOption(tokens, '--workspace') || hasOption(tokens, '-w')) && !workspace)
        throw new ReleaseError('Publish option --workspace requires a value.')

      if (tokens.includes('--workspaces') || tokens.includes('-ws')) {
        throw new ReleaseError(
          'Publishing multiple npm workspaces in one command cannot be authenticated safely.',
        )
      }

      const configuredCwd = cwdOption ?? prefixOption
      let cwd = configuredCwd ? repositoryPath(root, configuredCwd, 'publish cwd') : activeDirectory
      if (workspace) cwd = await resolveWorkspace(root, workspace)

      const manifest = await readManifest(cwd)
      if (!manifest) {
        throw new ReleaseError(
          `Could not read the package manifest used by publisher: ${relative(root, cwd) || '.'}`,
        )
      }

      let registry = optionValue(tokens, '--registry') ?? manifest?.publishConfig?.registry
      if (hasOption(tokens, '--registry') && !registry)
        throw new ReleaseError('Publish option --registry requires a URL.')
      if (registry) {
        registry = validateRegistry(registry)
      } else if (manifest?.name?.startsWith('@')) {
        const scope = manifest.name.split('/')[0]
        if (scope) {
          const configuredRegistry = await runner.run(
            npmCommand,
            ['config', 'get', `${scope}:registry`],
            { cwd, ...(signal ? { signal } : {}) },
          )
          const value = configuredRegistry.stdout.trim()
          if (
            configuredRegistry.exitCode === 0 &&
            value &&
            value !== 'undefined' &&
            value !== 'null'
          )
            registry = validateRegistry(value)
        }
      }
      publishers.push({ cwd, ...(registry ? { registry } : {}) })
    }
  }

  return publishers.filter(
    (publisher, index) =>
      publishers.findIndex(
        candidate => candidate.cwd === publisher.cwd && candidate.registry === publisher.registry,
      ) === index,
  )
}

function usesJsr(command: string): boolean {
  return (
    /(?:^|\s)(?:bunx|npx|yarn\s+dlx|pnpm\s+dlx)?\s*jsr\s+publish(?:\s|$)/u.test(command) ||
    /(?:^|\s)deno\s+publish(?:\s|$)/u.test(command)
  )
}

export async function checkRegistryAuthentication(
  publishCommands: string[],
  runner: CommandRunner,
  prompt: ReleasePrompt,
  logger: Logger,
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  for (const publisher of await npmPublishers(publishCommands, root, runner, signal)) {
    const registryArgs = publisher.registry ? ['--registry', publisher.registry] : []
    let whoami = await runner.run(npmCommand, ['whoami', ...registryArgs], {
      cwd: publisher.cwd,
      ...(signal ? { signal } : {}),
    })
    if (whoami.exitCode !== 0) {
      const login = await prompt.confirmNpmLogin()
      if (!login)
        throw new ReleaseError('npm authentication is required. Run `npm login` and retry.')

      expectSuccess(
        await runner.run(npmCommand, ['login', ...registryArgs], {
          cwd: publisher.cwd,
          stdio: 'inherit',
          ...(signal ? { signal } : {}),
        }),
        'npm login failed.',
      )
      whoami = await runner.run(npmCommand, ['whoami', ...registryArgs], {
        cwd: publisher.cwd,
        ...(signal ? { signal } : {}),
      })
      expectSuccess(whoami, 'npm authentication could not be verified after login.')
    }
    logger.info(
      `npm authentication${publisher.registry ? ` (${publisher.registry})` : ''}: ${whoami.stdout.trim()}`,
    )
  }

  if (publishCommands.some(usesJsr)) {
    if (!process.env.JSR_TOKEN) {
      throw new ReleaseError(
        'JSR authentication cannot be verified through browser approval before Git changes. Set JSR_TOKEN and retry.',
      )
    }
    logger.info('JSR authentication token is configured.')
  }
}
