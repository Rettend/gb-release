import type { CommandRunner } from './types.js'
import { expectSuccess } from './commands.js'
import { CommandError, ReleaseError } from './errors.js'

function options(cwd: string, signal?: AbortSignal) {
  return { cwd, ...(signal ? { signal } : {}) }
}

export async function repositoryRoot(
  runner: CommandRunner,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runner.run('git', ['rev-parse', '--show-toplevel'], options(cwd, signal))
  expectSuccess(result, 'gb-release must be run inside a Git repository.')
  return result.stdout.trim()
}

export async function currentBranch(
  runner: CommandRunner,
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runner.run(
    'git',
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    options(root, signal),
  )
  if (result.exitCode !== 0 || !result.stdout.trim())
    throw new ReleaseError('Releases cannot run from a detached HEAD.')

  return result.stdout.trim()
}

export async function assertCleanWorktree(
  runner: CommandRunner,
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runner.run(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    options(root, signal),
  )
  expectSuccess(result)
  if (result.stdout.trim()) {
    throw new ReleaseError(
      'The worktree is not clean. Commit or remove all changes before releasing.',
    )
  }
}

export async function isCleanWorktree(
  runner: CommandRunner,
  root: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await runner.run(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    options(root, signal),
  )
  expectSuccess(result, 'Could not inspect the worktree before restoring GitButler.')
  return !result.stdout.trim()
}

export async function validateTarget(
  runner: CommandRunner,
  root: string,
  remote: string,
  branch: string,
  requireLocalBranch: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const remoteResult = await runner.run('git', ['remote', 'get-url', remote], options(root, signal))
  expectSuccess(remoteResult, `Git remote does not exist: ${remote}`)

  const remoteBranch = await runner.run(
    'git',
    ['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`],
    options(root, signal),
  )
  expectSuccess(remoteBranch, `Target branch does not exist: ${remote}/${branch}`)

  if (requireLocalBranch) {
    const localBranch = await runner.run(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      options(root, signal),
    )
    if (localBranch.exitCode !== 0) {
      throw new ReleaseError(
        `Local branch "${branch}" is required before leaving GitButler workspace mode.`,
      )
    }
  }
}

export async function pullTarget(
  runner: CommandRunner,
  root: string,
  remote: string,
  branch: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runner.run('git', ['pull', '--ff-only', remote, branch], {
    ...options(root, signal),
    stdio: 'inherit',
  })
  expectSuccess(
    result,
    `Could not fast-forward ${branch} from ${remote}/${branch}. Resolve it manually.`,
  )
}

export async function assertTagAvailable(
  runner: CommandRunner,
  root: string,
  remote: string,
  tag: string,
  signal?: AbortSignal,
): Promise<void> {
  const validTag = await runner.run(
    'git',
    ['check-ref-format', `refs/tags/${tag}`],
    options(root, signal),
  )
  if (validTag.exitCode !== 0)
    throw new ReleaseError(`Configured tag name is not a valid Git ref: ${tag}`)

  const local = await runner.run(
    'git',
    ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`],
    options(root, signal),
  )
  if (local.exitCode === 0) throw new ReleaseError(`Tag already exists locally: ${tag}`)

  if (local.exitCode !== 1)
    throw new CommandError(local, `Could not check local tag availability for ${tag}.`)

  const remoteTag = await runner.run(
    'git',
    ['ls-remote', '--exit-code', '--tags', remote, `refs/tags/${tag}`],
    options(root, signal),
  )
  if (remoteTag.exitCode === 0) throw new ReleaseError(`Tag already exists on ${remote}: ${tag}`)

  if (remoteTag.exitCode !== 2)
    throw new CommandError(remoteTag, `Could not check tag availability on ${remote}.`)
}

export async function readHead(
  runner: CommandRunner,
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runner.run('git', ['rev-parse', '--verify', 'HEAD'], options(root, signal))
  expectSuccess(result)
  return result.stdout.trim()
}

async function assertHead(
  runner: CommandRunner,
  root: string,
  expectedHead: string,
  signal?: AbortSignal,
): Promise<void> {
  const head = await readHead(runner, root, signal)
  if (head !== expectedHead)
    throw new ReleaseError('A preparation command changed Git HEAD. The release was stopped.')
}

function pathIsConfigured(path: string, configuredPaths: string[]): boolean {
  return configuredPaths.some(configuredPath => {
    const normalized = configuredPath.replaceAll('\\', '/').replace(/\/$/u, '')
    return path === normalized || path.startsWith(`${normalized}/`)
  })
}

export async function commitRelease(
  runner: CommandRunner,
  root: string,
  files: string[],
  message: string,
  expectedBranch: string,
  expectedParent: string,
  signal?: AbortSignal,
): Promise<void> {
  const branch = await currentBranch(runner, root, signal)
  if (branch !== expectedBranch)
    throw new ReleaseError(`A preparation command changed the checked-out branch to "${branch}".`)

  await assertHead(runner, root, expectedParent, signal)

  const preStaged = await runner.run(
    'git',
    ['diff', '--cached', '--name-only', '-z'],
    options(root, signal),
  )
  expectSuccess(preStaged)
  if (preStaged.stdout) {
    throw new ReleaseError(
      'A preparation command staged files. Preparation commands must not modify the Git index.',
    )
  }

  expectSuccess(await runner.run('git', ['add', '--force', '--', ...files], options(root, signal)))

  const unstaged = await runner.run('git', ['diff', '--quiet'], options(root, signal))
  if (unstaged.exitCode === 1) {
    throw new ReleaseError(
      'Preparation changed tracked files that are not configured in versionFiles or commitFiles.',
    )
  }
  if (unstaged.exitCode !== 0) throw new CommandError(unstaged)

  const untracked = await runner.run(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    options(root, signal),
  )
  expectSuccess(untracked)
  if (untracked.stdout.trim()) {
    throw new ReleaseError(
      `Preparation created unconfigured files:\n${untracked.stdout.trim()}\nAdd them to commitFiles or ignore them.`,
    )
  }

  const staged = await runner.run('git', ['diff', '--cached', '--quiet'], options(root, signal))
  if (staged.exitCode === 0)
    throw new ReleaseError('The selected version did not produce any release changes.')

  if (staged.exitCode !== 1) throw new CommandError(staged)

  expectSuccess(
    await runner.run('git', ['commit', '--only', '-m', message, '--', ...files], {
      ...options(root, signal),
      stdio: 'inherit',
    }),
  )
}

export async function validateReleaseCommit(
  runner: CommandRunner,
  root: string,
  files: string[],
  expectedParent: string,
  signal?: AbortSignal,
): Promise<void> {
  const parent = await runner.run('git', ['rev-parse', 'HEAD^'], options(root, signal))
  expectSuccess(parent)
  if (parent.stdout.trim() !== expectedParent) {
    throw new ReleaseError(
      'The release commit was not created directly on the validated target commit.',
    )
  }

  const committedPaths = await runner.run(
    'git',
    ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'],
    options(root, signal),
  )
  expectSuccess(committedPaths)
  const unexpectedPath = committedPaths.stdout
    .split('\0')
    .filter(Boolean)
    .find(path => !pathIsConfigured(path, files))
  if (unexpectedPath)
    throw new ReleaseError(`The release commit unexpectedly contains: ${unexpectedPath}`)

  await assertCleanWorktree(runner, root, signal)
}

export async function createTag(
  runner: CommandRunner,
  root: string,
  tag: string,
  signal?: AbortSignal,
): Promise<void> {
  expectSuccess(
    await runner.run('git', ['tag', '--annotate', tag, '--message', tag], options(root, signal)),
  )
}

export async function assertReleaseReadyToPush(
  runner: CommandRunner,
  root: string,
  branch: string,
  tag: string,
  signal?: AbortSignal,
): Promise<void> {
  const checkedOutBranch = await currentBranch(runner, root, signal)
  if (checkedOutBranch !== branch) {
    throw new ReleaseError(
      `A project command changed the checked-out branch to "${checkedOutBranch}".`,
    )
  }

  const head = await readHead(runner, root, signal)
  const branchResult = await runner.run(
    'git',
    ['rev-parse', '--verify', `refs/heads/${branch}`],
    options(root, signal),
  )
  const tagResult = await runner.run(
    'git',
    ['rev-parse', '--verify', `${tag}^{commit}`],
    options(root, signal),
  )
  expectSuccess(branchResult)
  expectSuccess(tagResult)
  if (branchResult.stdout.trim() !== head || tagResult.stdout.trim() !== head)
    throw new ReleaseError('The release branch, tag, and HEAD no longer identify the same commit.')
}

function parseLsRemote(output: string): Map<string, string> {
  return new Map(
    output
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(line => {
        const [commit = '', ref = ''] = line.split(/\s+/u, 2)
        return [ref, commit]
      }),
  )
}

export async function assertPublishOnlyRelease(
  runner: CommandRunner,
  root: string,
  remote: string,
  branch: string,
  tag: string,
  signal?: AbortSignal,
): Promise<void> {
  const validTag = await runner.run(
    'git',
    ['check-ref-format', `refs/tags/${tag}`],
    options(root, signal),
  )
  if (validTag.exitCode !== 0)
    throw new ReleaseError(`Configured tag name is not a valid Git ref: ${tag}`)

  const checkedOutBranch = await currentBranch(runner, root, signal)
  if (checkedOutBranch !== branch) {
    throw new ReleaseError(
      `Publication retry must run from "${branch}", not "${checkedOutBranch}".`,
    )
  }

  const head = await readHead(runner, root, signal)
  const localTag = await runner.run(
    'git',
    ['rev-parse', '--verify', `${tag}^{commit}`],
    options(root, signal),
  )
  if (localTag.exitCode !== 0) {
    throw new ReleaseError(
      `Cannot retry publication because local release tag ${tag} does not exist.`,
    )
  }

  const remoteTag = await runner.run(
    'git',
    ['ls-remote', '--exit-code', '--tags', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    options(root, signal),
  )
  if (remoteTag.exitCode !== 0)
    throw new ReleaseError(`Cannot retry publication because ${remote}/${tag} does not exist.`)

  const remoteBranch = await runner.run(
    'git',
    ['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`],
    options(root, signal),
  )
  expectSuccess(remoteBranch, `Could not verify ${remote}/${branch} before retrying publication.`)

  const tagRefs = parseLsRemote(remoteTag.stdout)
  const branchRefs = parseLsRemote(remoteBranch.stdout)
  const peeledTag = tagRefs.get(`refs/tags/${tag}^{}`) ?? tagRefs.get(`refs/tags/${tag}`)
  const remoteHead = branchRefs.get(`refs/heads/${branch}`)
  const localRelease = localTag.stdout.trim()
  if (
    !peeledTag ||
    !remoteHead ||
    head !== localRelease ||
    head !== peeledTag ||
    head !== remoteHead
  ) {
    throw new ReleaseError(
      `Publication retry requires HEAD, ${remote}/${branch}, and ${remote}/${tag} to identify the same release commit.`,
    )
  }
}

export async function pushRelease(
  runner: CommandRunner,
  root: string,
  remote: string,
  branch: string,
  tag: string,
  signal?: AbortSignal,
): Promise<void> {
  expectSuccess(
    await runner.run('git', ['push', remote, `refs/heads/${branch}:refs/heads/${branch}`], {
      ...options(root, signal),
      stdio: 'inherit',
    }),
    `Release commit could not be pushed. Retry with: git push ${remote} ${branch}`,
  )
  expectSuccess(
    await runner.run('git', ['push', remote, `refs/tags/${tag}:refs/tags/${tag}`], {
      ...options(root, signal),
      stdio: 'inherit',
    }),
    `Release tag could not be pushed. Retry with: git push ${remote} ${tag}`,
  )
}
