# gb-release

`gb-release` is an interactive package release CLI that works in normal Git
repositories and safely transitions out of GitButler workspace mode before it
creates release commits or tags.

## Install

```sh
bun add --dev @rettend/release
```

```json
{
  "scripts": {
    "release": "gb-release"
  }
}
```

## Configure

Create `release.config.ts` at the repository root:

```ts
import { defineConfig } from "@rettend/release";

export default defineConfig({
  versionFiles: ["package.json", "jsr.json"],
  prepare: "bun run build",
  publish: "bun publish",
});
```

The default target is `origin/main`. Run the release after Landing the intended
GitButler branch:

```sh
bun run release
```

Only version files are committed by default. Add generated files explicitly
when a package ships build output:

```ts
export default defineConfig({
  versionFiles: ["package.json"],
  prepare: "bun run build",
  commitFiles: ["dist"],
  publish: "bun publish",
});
```

## Options

```text
gb-release --config release.config.ts
gb-release --branch master
gb-release --publish-only
gb-release --no-restore
```

`--publish-only` retries the configured preparation and publish commands without
changing the version or Git history. For safety, the checked-out branch, its
remote tip, and the release tag must still identify the same release commit.
