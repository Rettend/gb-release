import { spawn } from "node:child_process";
import { CommandError, ReleaseError } from "./errors.js";
import type { CommandOptions, CommandResult, CommandRunner } from "./types.js";

function quoteArgument(value: string): string {
  return /[\s"']/u.test(value) ? JSON.stringify(value) : value;
}

async function spawnCommand(
  command: string,
  args: string[],
  options: CommandOptions,
  shell: boolean,
): Promise<CommandResult> {
  const displayCommand = [command, ...args.map(quoteArgument)].join(" ");
  const inherited = options.stdio === "inherit";

  return await new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    const usesWindowsCommandShell = process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command);
    const childCommand = usesWindowsCommandShell
      ? process.env.ComSpec ?? "cmd.exe"
      : command;
    const childArgs = usesWindowsCommandShell
      ? ["/d", "/s", "/c", [command, ...args].join(" ")]
      : args;
    const child = spawn(childCommand, childArgs, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      shell,
      stdio: inherited ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: !inherited,
    });
    let stdout = "";
    let stderr = "";

    if (!inherited) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }

    const abort = () => {
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.unref();
      } else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    child.once("error", (error) => {
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      const abortReason = options.signal?.aborted ? options.signal.reason : undefined;
      resolve({
        command: displayCommand,
        exitCode: abortReason instanceof ReleaseError
          ? abortReason.exitCode
          : code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1),
        stdout,
        stderr,
        ...(signal ? { signal } : {}),
      });
    });
  });
}

export class NodeCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    return await spawnCommand(command, args, options, false);
  }

  async shell(command: string, options: CommandOptions): Promise<CommandResult> {
    return await spawnCommand(command, [], options, true);
  }
}

export function expectSuccess(result: CommandResult, message?: string): CommandResult {
  if (result.exitCode !== 0) {
    throw new CommandError(result, message);
  }
  return result;
}

export async function runProjectCommands(
  commands: string[],
  runner: CommandRunner,
  cwd: string,
  signal: AbortSignal | undefined,
  announce: (command: string) => void,
): Promise<void> {
  for (const command of commands) {
    announce(`$ ${command}`);
    const result = await runner.shell(command, {
      cwd,
      stdio: "inherit",
      ...(signal ? { signal } : {}),
    });
    expectSuccess(result);
  }
}
