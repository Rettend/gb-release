#!/usr/bin/env node

import type { Logger } from './types.js'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { NodeCommandRunner } from './commands.js'
import { ReleaseError } from './errors.js'
import { InteractiveReleasePrompt } from './prompt.js'
import { runRelease } from './release.js'

interface CliOptions {
  configPath?: string
  branch?: string
  publishOnly?: boolean
  noRestore?: boolean
  help?: boolean
  version?: boolean
}

const HELP = `Usage: gb-release [options]

Options:
  --config <path>  Use a different configuration file
  --branch <name>  Override the configured target branch
  --publish-only   Retry publishing the current version only
  --no-restore     Stay in normal Git mode after a GitButler release
  -h, --help       Show this help
  -v, --version    Show the installed version`

function parseArguments(args: string[]): CliOptions {
  const options: CliOptions = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--config' || argument === '--branch') {
      const value = args[index + 1]
      if (!value || value.startsWith('-')) throw new ReleaseError(`${argument} requires a value.`)

      if (argument === '--config') options.configPath = value
      else options.branch = value
      index += 1
    } else if (argument === '--publish-only') {
      options.publishOnly = true
    } else if (argument === '--no-restore') {
      options.noRestore = true
    } else if (argument === '--help' || argument === '-h') {
      options.help = true
    } else if (argument === '--version' || argument === '-v') {
      options.version = true
    } else {
      throw new ReleaseError(`Unknown option: ${argument}`)
    }
  }
  return options
}

async function packageVersion(): Promise<string> {
  const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { version: string }
  return packageJson.version
}

const logger: Logger = {
  info: message => console.log(message),
  warn: message => console.warn(`Warning: ${message}`),
  error: message => console.error(message),
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseArguments(args)
    if (options.help) {
      console.log(HELP)
      return 0
    }
    if (options.version) {
      console.log(await packageVersion())
      return 0
    }

    const controller = new AbortController()
    const interrupt = () => controller.abort(new ReleaseError('Release interrupted.', 130))
    const terminate = () => controller.abort(new ReleaseError('Release terminated.', 143))
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', terminate)
    try {
      const version = await runRelease({
        cwd: process.cwd(),
        runner: new NodeCommandRunner(),
        prompt: new InteractiveReleasePrompt(),
        logger,
        signal: controller.signal,
        ...(options.configPath ? { configPath: options.configPath } : {}),
        ...(options.branch ? { branch: options.branch } : {}),
        ...(options.publishOnly ? { publishOnly: true } : {}),
        ...(options.noRestore ? { noRestore: true } : {}),
      })
      console.log(`Released ${version}.`)
      return 0
    } finally {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', terminate)
    }
  } catch (error) {
    if (error instanceof ReleaseError) {
      console.error(error.message)
      return error.exitCode
    }
    if (error instanceof Error && error.name === 'AbortError') {
      console.error('Release interrupted.')
      return 130
    }
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    return 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = await main()
