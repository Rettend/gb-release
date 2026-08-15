import type { CommandRunner, Logger, ReleasePrompt } from './types.js'
import { checkRegistryAuthentication } from './auth.js'
import { runProjectCommands } from './commands.js'
import { formatTemplate, loadConfig } from './config.js'
import { ReleaseError } from './errors.js'
import {
  assertCleanWorktree,
  assertPublishOnlyRelease,
  assertReleaseReadyToPush,
  assertTagAvailable,
  commitRelease,
  createTag,
  currentBranch,
  isCleanWorktree,
  pullTarget,
  pushRelease,
  readHead,
  repositoryRoot,
  validateReleaseCommit,
  validateTarget,
} from './git.js'
import {
  inspectGitButlerWorkspace,
  isGitButlerWorkspace,
  restoreGitButler,
  teardownGitButler,
} from './gitbutler.js'
import { readCurrentVersion, updateVersionFiles } from './version.js'

export interface RunReleaseOptions {
  cwd: string
  configPath?: string
  branch?: string
  publishOnly?: boolean
  noRestore?: boolean
  runner: CommandRunner
  prompt: ReleasePrompt
  logger: Logger
  signal?: AbortSignal
}

type ReleasePhase = 'initial' | 'normal-git' | 'versioned' | 'committed' | 'pushed' | 'published'

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    if (signal.reason instanceof Error) throw signal.reason
    throw new ReleaseError('Release interrupted.', 130)
  }
}

function configsMatch(
  first: Awaited<ReturnType<typeof loadConfig>>,
  second: Awaited<ReturnType<typeof loadConfig>>,
): boolean {
  return JSON.stringify(first) === JSON.stringify(second)
}

async function repositoryStateMatches(
  runner: CommandRunner,
  root: string,
  branch: string,
  head: string,
): Promise<boolean> {
  try {
    return (await currentBranch(runner, root)) === branch && (await readHead(runner, root)) === head
  } catch {
    return false
  }
}

export async function runRelease(options: RunReleaseOptions): Promise<string> {
  const { runner, prompt, logger, signal } = options
  const root = await repositoryRoot(runner, options.cwd, signal)
  let config = await loadConfig(root, options.configPath)
  if (options.branch) config.target.branch = options.branch
  if (options.publishOnly && config.publish.length === 0)
    throw new ReleaseError('--publish-only requires at least one configured publish command.')

  const branch = await currentBranch(runner, root, signal)
  const startedInGitButler = isGitButlerWorkspace(branch)
  let phase: ReleasePhase = 'initial'
  let shouldRestore = false
  let version = ''
  let releaseFailed = false
  let ambiguousState = false
  let releaseBase = ''
  let releaseCommit = ''

  if (startedInGitButler) {
    await assertCleanWorktree(runner, root, signal)
    await inspectGitButlerWorkspace(runner, root, logger, signal)
  } else {
    if (branch !== config.target.branch) {
      throw new ReleaseError(
        `Releases must run from "${config.target.branch}", but HEAD is on "${branch}".`,
      )
    }
    await assertCleanWorktree(runner, root, signal)
  }

  await validateTarget(
    runner,
    root,
    config.target.remote,
    config.target.branch,
    startedInGitButler,
    signal,
  )
  version = await readCurrentVersion(root, config.versionFiles)
  await checkRegistryAuthentication(config.publish, runner, prompt, logger, root, signal)
  await assertCleanWorktree(runner, root, signal)
  assertNotAborted(signal)

  try {
    if (startedInGitButler) {
      await inspectGitButlerWorkspace(runner, root, logger, signal, false)
      logger.info(`Leaving GitButler workspace mode for ${config.target.branch}.`)
      await teardownGitButler(runner, root, config.target.branch, signal)
      phase = 'normal-git'
      await pullTarget(runner, root, config.target.remote, config.target.branch, signal)
      shouldRestore = true
      await assertCleanWorktree(runner, root, signal)
      const targetConfig = await loadConfig(root, options.configPath)
      if (options.branch) targetConfig.target.branch = options.branch
      if (!configsMatch(config, targetConfig)) {
        throw new ReleaseError(
          'release.config.ts differs between the GitButler workspace and the Landed target branch. Land the configuration before releasing.',
        )
      }
      config = targetConfig
      version = await readCurrentVersion(root, config.versionFiles)
    }

    releaseBase = await readHead(runner, root, signal)

    if (options.publishOnly) {
      const tag = formatTemplate(config.tagName, version)
      await assertPublishOnlyRelease(
        runner,
        root,
        config.target.remote,
        config.target.branch,
        tag,
        signal,
      )
      await runProjectCommands(config.prepare, runner, root, signal, command =>
        logger.info(command),
      )
      await assertCleanWorktree(runner, root, signal)
      await assertPublishOnlyRelease(
        runner,
        root,
        config.target.remote,
        config.target.branch,
        tag,
        signal,
      )
      logger.info(`Publishing existing version ${version}.`)
      await runProjectCommands(config.publish, runner, root, signal, command =>
        logger.info(command),
      )
      await assertPublishOnlyRelease(
        runner,
        root,
        config.target.remote,
        config.target.branch,
        tag,
        signal,
      )
      phase = 'published'
      return version
    }

    const nextVersion = await prompt.selectVersion(version)
    if (nextVersion === version)
      throw new ReleaseError('The selected version matches the current version.')

    const tag = formatTemplate(config.tagName, nextVersion)
    const message = formatTemplate(config.commitMessage, nextVersion)
    await assertTagAvailable(runner, root, config.target.remote, tag, signal)
    assertNotAborted(signal)

    await updateVersionFiles(root, config.versionFiles, nextVersion)
    phase = 'versioned'
    await runProjectCommands(config.prepare, runner, root, signal, command => logger.info(command))
    const preparedVersion = await readCurrentVersion(root, config.versionFiles)
    if (preparedVersion !== nextVersion) {
      throw new ReleaseError(
        `Preparation changed the configured version to ${preparedVersion}; expected ${nextVersion}.`,
      )
    }
    await commitRelease(
      runner,
      root,
      [...config.versionFiles, ...config.commitFiles],
      message,
      config.target.branch,
      releaseBase,
      signal,
    )
    phase = 'committed'
    await validateReleaseCommit(
      runner,
      root,
      [...config.versionFiles, ...config.commitFiles],
      releaseBase,
      signal,
    )
    releaseCommit = await readHead(runner, root, signal)
    await createTag(runner, root, tag, signal)
    await assertReleaseReadyToPush(runner, root, config.target.branch, tag, signal)
    await pushRelease(runner, root, config.target.remote, config.target.branch, tag, signal)
    phase = 'pushed'

    try {
      await runProjectCommands(config.publish, runner, root, signal, command =>
        logger.info(command),
      )
    } catch (error) {
      logger.error(`Git history for ${tag} was pushed, but publication is incomplete.`)
      for (const command of config.publish) logger.error(`Retry: ${command}`)
      throw error
    }
    await assertReleaseReadyToPush(runner, root, config.target.branch, tag, signal)
    phase = 'published'
    version = nextVersion
    return version
  } catch (error) {
    releaseFailed = true
    const expectedHead =
      phase === 'committed' ? '' : phase === 'pushed' ? releaseCommit : releaseBase
    if (
      expectedHead &&
      !(await repositoryStateMatches(runner, root, config.target.branch, expectedHead))
    ) {
      ambiguousState = true
      logger.error(
        'A project command changed the checked-out branch or Git HEAD. GitButler will not be restored automatically.',
      )
    }
    if (phase === 'versioned') {
      logger.error(
        'Release files were changed but not committed. Inspect them, then revert or retry.',
      )
    } else if (phase === 'committed') {
      logger.error(
        'The local release commit and any tag were kept. Push them explicitly after resolving the error.',
      )
    }

    throw error
  } finally {
    if (startedInGitButler && shouldRestore && !options.noRestore) {
      let clean: boolean | undefined
      let statusError: unknown
      try {
        clean = await isCleanWorktree(runner, root)
      } catch (error) {
        statusError = error
      }
      const unambiguous = phase !== 'committed' && !ambiguousState
      if (statusError) {
        if (!releaseFailed) throw statusError
        logger.error(
          `Could not verify the worktree before GitButler restoration: ${statusError instanceof Error ? statusError.message : String(statusError)}`,
        )
      } else if (clean && unambiguous) {
        try {
          logger.info('Restoring GitButler workspace mode.')
          await restoreGitButler(runner, root)
        } catch (restoreError) {
          if (!releaseFailed) throw restoreError
          logger.error(
            `GitButler restoration also failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          )
        }
      } else if (!clean) {
        logger.warn('GitButler was not restored because the worktree contains release changes.')
      } else {
        logger.warn(
          'GitButler was not restored because the local release state needs manual recovery.',
        )
      }
    }
  }
}
