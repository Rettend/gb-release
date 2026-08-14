import { expectSuccess } from "./commands.js";
import { ReleaseError } from "./errors.js";
import type { CommandRunner, Logger } from "./types.js";

interface ButlerStatus {
  uncommittedChanges: unknown[];
  stacks: Array<{
    name?: string;
    branches: Array<{ name?: string }>;
  }>;
}

function options(cwd: string, signal?: AbortSignal) {
  return { cwd, ...(signal ? { signal } : {}) };
}

export function isGitButlerWorkspace(branch: string): boolean {
  return branch === "gitbutler/workspace";
}

export async function inspectGitButlerWorkspace(
  runner: CommandRunner,
  root: string,
  logger: Logger,
  signal?: AbortSignal,
  showAppliedBranches = true,
): Promise<void> {
  const result = await runner.run("but", ["status", "--json"], options(root, signal));
  expectSuccess(result, "Could not inspect the GitButler workspace with `but status --json`.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new ReleaseError("GitButler returned an invalid status response.", 1, { cause: error });
  }

  if (
    !parsed
    || typeof parsed !== "object"
    || !Array.isArray((parsed as Partial<ButlerStatus>).uncommittedChanges)
    || !Array.isArray((parsed as Partial<ButlerStatus>).stacks)
    || (parsed as Partial<ButlerStatus>).stacks?.some((stack) => (
      !stack
      || typeof stack !== "object"
      || !Array.isArray(stack.branches)
      || stack.branches.some((branch) => !branch || typeof branch !== "object")
    ))
  ) {
    throw new ReleaseError(
      "The installed GitButler returned an unsupported status schema. Update gb-release before continuing.",
    );
  }
  const status = parsed as ButlerStatus;

  if (status.uncommittedChanges.length > 0) {
    throw new ReleaseError(
      "The GitButler workspace has uncommitted or assigned changes. Commit them before releasing.",
    );
  }

  const branchNames = status.stacks.flatMap((stack) => {
    const names = stack.branches.map((branch) => branch.name).filter(Boolean);
    return names.length > 0 ? names : stack.name ? [stack.name] : [];
  });
  if (showAppliedBranches && branchNames.length > 0) {
    logger.warn(
      `Applied GitButler branches will not be released unless already Landed: ${branchNames.join(", ")}`,
    );
  }
}

export async function teardownGitButler(
  runner: CommandRunner,
  root: string,
  branch: string,
  signal?: AbortSignal,
): Promise<void> {
  expectSuccess(await runner.run(
    "but",
    ["teardown", "--checkout-to", branch],
    { ...options(root, signal), stdio: "inherit" },
  ), `Could not leave GitButler workspace mode on branch "${branch}".`);
}

export async function restoreGitButler(
  runner: CommandRunner,
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  expectSuccess(await runner.run(
    "but",
    ["setup"],
    { ...options(root, signal), stdio: "inherit" },
  ), "Release finished, but `but setup` could not restore GitButler workspace mode.");
  expectSuccess(await runner.run(
    "but",
    ["pull"],
    { ...options(root, signal), stdio: "inherit" },
  ), "GitButler was restored, but `but pull` could not reconcile the workspace.");
}
