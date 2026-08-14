# gb-release

## Summary

`gb-release` is a small release CLI designed to make interactive package releases safe in both normal Git repositories and GitButler-managed workspaces.

The project and executable are named `gb-release`. Everything else uses the shorter `release` name:

- Repository: `gb-release`
- Package: `@rettend/release`
- Executable: `gb-release`
- Configuration: `release.config.ts`
- Package export: `defineConfig`

Projects install `@rettend/release` and reduce their release script to:

```json
{
  "scripts": {
    "release": "gb-release"
  },
  "devDependencies": {
    "@rettend/release": "^0.1.0"
  }
}
```

The initial use cases are `gau` and `starlight-plugin-icons`. The CLI should remain generic enough for other JavaScript packages without becoming a full release-management framework.

## Background

### Existing release workflow

Several projects currently use `bumpp` followed by build and publish commands. For example, Gau uses:

```json
{
  "release": "bumpp packages/gau/package.json packages/gau/jsr.json && bun run build && bun publish --cwd packages/gau"
}
```

This is convenient because bumpp presents an interactive version chooser with the next patch, minor, and major versions. However, bumpp also enables Git operations by default. Its release flow runs commands equivalent to:

```text
git commit
git tag
git push
git push --tags
```

### GitButler incompatibility

In GitButler workspace mode, the checked-out branch is `gitbutler/workspace`. This is a synthetic integration branch representing the combined state of all applied virtual branches. It must not be committed to or pushed as a normal branch.

Running bumpp directly in this state can:

- Attempt to commit on top of the synthetic workspace commit.
- Push or recreate `origin/gitbutler/workspace` instead of updating `main`.
- Create a release tag whose commit is not part of `main`.
- Include the combined state of multiple applied branches in an unsafe direct push.
- Be rejected by GitButler's managed pre-commit hook in newer setups.

Changing Git's global push configuration is not a safe solution. Redirecting `gitbutler/workspace` to `main` could publish the synthetic workspace commit and unrelated applied branches.

### GitButler Land behavior

GitButler's Land action safely integrates a named virtual branch directly into the configured target, such as `origin/main`, without creating a pull request. It fast-forwards when possible, otherwise creates a merge commit, pushes the target, and reconciles the remaining workspace.

Land does not intercept arbitrary `git commit` or `git push` commands. It also intentionally leaves the local `main` branch unchanged when landing to a real remote. A release process therefore needs to update local `main` before running normal Git-based release tooling.

The intended user workflow is:

1. Land the feature branch in GitButler.
2. Run `bun run release`, which invokes `gb-release`.

The CLI handles the temporary transition to normal Git mode and back.

## Goals

- Preserve a simple interactive patch, minor, major, or custom version chooser.
- Keep release scripts consistent across projects.
- Safely release from repositories managed by GitButler.
- Support arbitrary version files such as `package.json` and `jsr.json`.
- Run project-specific build or preparation commands before committing the release.
- Support npm-compatible publishing through either `bun publish` or `npm publish`.
- Allow JSR publishing when configured.
- Check authentication before changing versions or Git state.
- Make all project-specific behavior visible in `release.config.ts`.
- Work normally outside GitButler without requiring a separate workflow.

## Non-Goals

- Automatically deciding which GitButler branch should be Landed.
- Replacing pull requests, GitButler Land, or branch-protection policies.
- Managing changelogs, GitHub Releases, or release notes in the initial version.
- Supporting every package manager or registry in the initial version.
- Hiding project-specific build and publish behavior behind unreliable inference.
- Automatically rolling back a package that has already been published.

## Proposed Workflow

Running `gb-release` performs the following steps.

### 1. Load and validate configuration

Locate `release.config.ts` from the repository root and validate:

- Version files exist.
- Build and publish commands are valid non-empty commands.
- The configured target branch and remote are available.
- At least one version file contains a valid current version.

### 2. Inspect repository state

Determine whether `HEAD` is `gitbutler/workspace` or a normal Git branch.

In GitButler mode:

- Ensure there are no uncommitted or assigned worktree changes.
- Display any still-applied virtual branches and explain that they are not included unless already Landed.
- Determine the target, initially defaulting to `origin/main` with configuration overrides available.

In normal Git mode:

- Require the configured release branch, normally `main`.
- Require a clean worktree.

### 3. Check registry authentication

Authentication is checked before versions, commits, tags, or branches are changed.

For npm-compatible publishing:

- Check the configured registry identity, normally with `npm whoami`.
- If unauthenticated and running interactively, offer to run `npm login` with inherited terminal input and output.
- Verify authentication again before continuing.
- `bun publish` can then use the npm credentials stored in the user's npm configuration.

For JSR publishing:

- Run the appropriate JSR authentication check before changing repository state.
- If authentication cannot be verified automatically, fail with a specific login command rather than discovering the problem after pushing the release tag.

Authentication checks should only run for configured publishers.

### 4. Enter normal Git mode

When starting from `gitbutler/workspace`:

```text
but teardown --checkout-to main
git pull --ff-only origin main
```

The pull must be fast-forward-only. Diverged local history is an error requiring manual resolution.

The CLI records that it started in GitButler mode so it can restore the workspace later.

### 5. Choose the version

Present a focused prompt:

```text
Current version: 1.4.6

> patch   1.4.7
  minor   1.5.0
  major   2.0.0
  custom
```

Prerelease and other advanced bumpp options are not needed initially.

The implementation may use bumpp internally for reliable multi-file version updates, but bumpp must be configured with its Git commit, tag, and push behavior disabled. `gb-release` owns all Git operations.

### 6. Update version files

Update every configured version file to the selected version. The initial implementation should support:

- `package.json`
- `jsr.json`
- Additional JSON or JSONC files supported by bumpp

All configured files must agree on the current version unless a future option explicitly allows otherwise.

### 7. Run preparation commands

Run configured commands in order after updating versions and before creating the release commit. Typical commands include:

- `bun run build`
- Package checks or tests
- Extension packaging
- Asset bundling

If any command fails, do not commit, tag, push, or publish. Leave the modified version files visible for inspection and do not automatically switch back into GitButler mode while the worktree is dirty.

### 8. Commit and tag

Create a release commit and annotated tag on the real target branch:

```text
chore: release v1.4.7
v1.4.7
```

Only configured release files should be committed by default. Build outputs are included only if the project explicitly configures them.

### 9. Push explicitly

Avoid bare `git push`. Push the intended branch and tag explicitly:

```text
git push origin main
git push origin v1.4.7
```

Branch protection or a non-fast-forward update must fail before publishing.

### 10. Publish

Run configured publish commands in order. Initial supported forms can be ordinary commands with inherited terminal input and output:

```ts
publish: [
  "bun publish --cwd packages/gau",
]
```

Structured publishers can be added when they provide concrete value:

```ts
publish: [
  {
    registry: "npm",
    command: "bun publish --cwd packages/gau",
  },
  {
    registry: "jsr",
    command: "bunx jsr publish --cwd packages/gau",
  },
]
```

If publishing fails after the commit and tag were pushed, report the partial release clearly and print the exact command needed to retry. Do not bump the version again automatically.

### 11. Restore GitButler

If the process started in GitButler mode and the worktree is clean:

```text
but setup
but pull
```

`but pull` is necessary because setup can restore workspace mode while still retaining the previous workspace base. Pulling reconciles the workspace with the new release commit on `origin/main`.

The original release command's exit status must be preserved even if workspace restoration succeeds.

## Configuration API

The package exports `defineConfig`:

```ts
import { defineConfig } from "@rettend/release";

export default defineConfig({
  target: {
    remote: "origin",
    branch: "main",
  },
  versionFiles: ["package.json"],
  prepare: [],
  publish: [],
});
```

Proposed initial shape:

```ts
export interface ReleaseConfig {
  target?: {
    remote?: string;
    branch?: string;
  };
  versionFiles?: string[];
  prepare?: string | string[];
  publish?: string | string[];
  commitMessage?: string;
  tagName?: string;
}
```

Defaults:

```ts
{
  target: {
    remote: "origin",
    branch: "main",
  },
  versionFiles: ["package.json"],
  prepare: [],
  publish: [],
  commitMessage: "chore: release v%s",
  tagName: "v%s",
}
```

Keep the first schema command-oriented. Structured npm and JSR publishers should only replace command strings once authentication checks, retry behavior, or registry metadata require them.

## Gau Configuration

Initial equivalent of Gau's existing workflow:

```ts
// release.config.ts
import { defineConfig } from "@rettend/release";

export default defineConfig({
  versionFiles: [
    "packages/gau/package.json",
    "packages/gau/jsr.json",
  ],
  prepare: "bun run build",
  publish: "bun publish --cwd packages/gau",
});
```

Root package script:

```json
{
  "scripts": {
    "release": "gb-release"
  }
}
```

If Gau is also published to JSR later, add its JSR publish command as a second publisher rather than coupling JSR publishing to the existence of `jsr.json`.

## Starlight Plugin Icons Configuration

Initial equivalent of the existing workflow:

```ts
// release.config.ts
import { defineConfig } from "@rettend/release";

export default defineConfig({
  versionFiles: [
    "packages/starlight-plugin-icons/package.json",
  ],
  publish: "npm publish --workspace starlight-plugin-icons",
});
```

Root package script:

```json
{
  "scripts": {
    "release": "gb-release"
  }
}
```

The CLI should perform npm authentication before the version prompt because this publisher requires npm credentials.

## Failure and Recovery Rules

The CLI must favor stopping safely over trying to repair uncertain repository state.

### Before version changes

- Authentication failure: remain in the original GitButler state.
- Dirty worktree: abort without switching branches.
- Unknown target: abort and request explicit configuration.
- Non-fast-forward main update: remain in normal mode and request manual resolution.

### After version changes but before commit

- Preparation failure: leave version changes uncommitted for inspection.
- Do not run `but setup` while release changes remain dirty.
- Print a clear recovery option to revert or retry.

### After commit but before push

- Keep the local commit and tag.
- Print explicit retry commands.
- Restoration is allowed only when it does not hide or rewrite the failed release state.

### After push but before or during publish

- Never delete a remote tag automatically.
- Report that Git history was released but registry publication is incomplete.
- Print a publish-only retry command or the configured underlying publish command.
- A future `gb-release --publish-only` mode should retry publication without creating another version.

### Interruption

- Handle Ctrl+C and termination signals where practical.
- Restore GitButler only if the worktree is clean and no ambiguous local release state remains.
- Always preserve the failing command's exit status.

## CLI Surface

Initial command:

```text
gb-release
```

Useful early options:

```text
gb-release --config release.config.ts
gb-release --branch master
gb-release --publish-only
gb-release --no-restore
```

Avoid adding advanced versioning options until a real project needs them. The interactive patch, minor, major, and custom choices are the main interface.

## Implementation Outline

The package can be a small TypeScript project targeting Bun and modern Node.js.

Suggested modules:

```text
src/
  cli.ts
  config.ts
  version.ts
  git.ts
  gitbutler.ts
  auth.ts
  commands.ts
  release.ts
```

Responsibilities:

- `cli.ts`: arguments, prompt, output, and exit codes.
- `config.ts`: locate, load, default, and validate `release.config.ts`.
- `version.ts`: current-version discovery, version choices, and bumpp integration.
- `git.ts`: clean-state checks, target updates, explicit commit, tag, and push.
- `gitbutler.ts`: workspace detection, teardown, restoration, and pull.
- `auth.ts`: registry authentication preflight.
- `commands.ts`: execute configured commands with inherited terminal streams.
- `release.ts`: ordered release state machine and recovery reporting.

External commands should be executed as argument arrays where possible rather than concatenated shell strings. Configured project commands may initially use the platform shell for convenience, but they should be displayed exactly before execution.

## Testing Strategy

The highest-value tests are workflow tests using temporary local Git repositories and bare remotes. They do not require the GitButler desktop application.

Test cases:

- Normal `main` release updates versions, builds, commits, tags, pushes, and publishes.
- GitButler workspace release tears down, releases on `main`, restores, and pulls.
- Direct commits on `gitbutler/workspace` are never attempted.
- Dirty workspace aborts before teardown.
- Applied GitButler branches produce a warning.
- Non-fast-forward target aborts before version changes.
- Authentication failure aborts before teardown and version changes.
- Preparation failure leaves versions uncommitted and does not push.
- Push failure does not publish.
- Publish failure reports a partial release and retry command.
- Multiple version files receive the same version.
- Custom version input is validated.
- `--publish-only` does not create a new commit or tag.

Command execution and prompts should be dependency-injected so most failure cases can be tested without real registry access.

## Initial Milestones

### Milestone 1: Local MVP

- Create the `gb-release` repository and `@rettend/release` package.
- Load `release.config.ts`.
- Detect normal Git and GitButler workspace modes.
- Implement teardown, target update, setup, and pull.
- Add the patch, minor, major, and custom prompt.
- Update multiple version files through bumpp without bumpp Git operations.
- Run preparation commands.
- Commit, tag, and explicitly push.
- Run command-based publishers.
- Test against temporary local remotes.

### Milestone 2: Adopt In Active Projects

- Add configurations to Gau and Starlight Plugin Icons.
- Replace their release scripts with `gb-release`.
- Validate npm authentication and interactive terminal behavior on Windows.
- Perform dry local releases against disposable repositories before publishing anything.

### Milestone 3: Registry Hardening

- Add explicit npm and JSR publisher types if command-based publishing becomes limiting.
- Add authentication preflight and login assistance per registry.
- Add `--publish-only` recovery.
- Improve partial-release reporting.

## Open Decisions

- Whether to depend on bumpp's programmatic API or implement JSON version updates directly.
- Whether npm authentication should automatically launch `npm login` or ask the user first.
- The exact JSR authentication check and retry flow.
- Whether preparation commands should be named `prepare`, `build`, or `beforeCommit`.
- Whether publish commands should remain strings in version 0.1 or use structured publishers immediately.
- Whether restoration should happen automatically after a clean publish failure.
- Whether the package should generate a starter `release.config.ts`.

The MVP should resolve only the decisions required by Gau and Starlight Plugin Icons and defer broader abstractions until another active package needs them.
