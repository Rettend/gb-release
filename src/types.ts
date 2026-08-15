export interface ReleaseConfig {
  target?: {
    remote?: string
    branch?: string
  }
  versionFiles?: string[]
  prepare?: string | string[]
  publish?: string | string[]
  commitFiles?: string[]
  commitMessage?: string
  tagName?: string
}

export interface ResolvedReleaseConfig {
  target: {
    remote: string
    branch: string
  }
  versionFiles: string[]
  prepare: string[]
  publish: string[]
  commitFiles: string[]
  commitMessage: string
  tagName: string
}

export interface CommandOptions {
  cwd: string
  stdio?: 'capture' | 'inherit'
  signal?: AbortSignal
}

export interface CommandResult {
  command: string
  exitCode: number
  stdout: string
  stderr: string
  signal?: NodeJS.Signals
}

export interface CommandRunner {
  run(command: string, args: string[], options: CommandOptions): Promise<CommandResult>
  shell(command: string, options: CommandOptions): Promise<CommandResult>
}

export interface ReleasePrompt {
  selectVersion(currentVersion: string): Promise<string>
  confirmNpmLogin(): Promise<boolean>
}

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}
