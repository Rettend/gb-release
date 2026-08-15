import type { CommandResult } from './types.js'

export class ReleaseError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 1, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ReleaseError'
    this.exitCode = exitCode
  }
}

export class CommandError extends ReleaseError {
  readonly result: CommandResult

  constructor(result: CommandResult, message?: string) {
    const detail = result.stderr.trim() || result.stdout.trim()
    super(
      [message ?? `Command failed: ${result.command}`, detail].filter(Boolean).join('\n'),
      result.exitCode || 1,
    )
    this.name = 'CommandError'
    this.result = result
  }
}
