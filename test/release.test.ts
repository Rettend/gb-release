import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expectSuccess } from "../src/commands.js";
import { runRelease } from "../src/release.js";
import type { CommandRunner } from "../src/types.js";
import {
  ButlerTestRunner,
  createTestRepository,
  FixedPrompt,
  MemoryLogger,
  packageVersion,
  type TestRepository,
} from "./helpers.js";

const repositories: TestRepository[] = [];
setDefaultTimeout(15_000);

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.cleanup()));
});

async function git(runner: CommandRunner, cwd: string, args: string[]): Promise<string> {
  return expectSuccess(await runner.run("git", args, { cwd })).stdout.trim();
}

function workflowFiles(): Record<string, string> {
  return {
    "prepare.mjs": 'await Bun.write("prepare.log", "prepared");\n',
    "publish.mjs": 'await Bun.write("publish.log", "published");\n',
  };
}

describe("release workflow", () => {
  test("updates, prepares, commits, tags, pushes, and publishes on main", async () => {
    const repository = await createTestRepository({
      versionFiles: ["package.json", "jsr.json"],
      prepare: "bun ./prepare.mjs",
      publish: "bun ./publish.mjs",
    }, {
      ...workflowFiles(),
      "jsr.json": '{\n  "name": "@test/package",\n  "version": "1.0.0",\n  "exports": "./index.ts"\n}\n',
      "index.ts": "export {};\n",
    });
    repositories.push(repository);

    const version = await runRelease({
      cwd: repository.root,
      runner: repository.runner,
      prompt: new FixedPrompt(),
      logger: new MemoryLogger(),
    });

    expect(version).toBe("1.0.1");
    expect(await packageVersion(join(repository.root, "package.json"))).toBe("1.0.1");
    expect(JSON.parse(await readFile(join(repository.root, "jsr.json"), "utf8")).version).toBe("1.0.1");
    expect(await readFile(join(repository.root, "prepare.log"), "utf8")).toBe("prepared");
    expect(await readFile(join(repository.root, "publish.log"), "utf8")).toBe("published");
    expect(await git(repository.runner, repository.root, ["log", "-1", "--pretty=%s"])).toBe(
      "chore: release v1.0.1",
    );
    expect(await git(repository.runner, repository.root, ["tag", "--list", "v1.0.1"])).toBe("v1.0.1");
    expect(await git(repository.runner, repository.remote, ["show", "main:package.json"])).toContain(
      '"version": "1.0.1"',
    );
  });

  test("leaves version changes visible when preparation fails", async () => {
    const repository = await createTestRepository({
      prepare: "bun ./fail.mjs",
      publish: "bun ./publish.mjs",
    }, {
      "fail.mjs": "process.exit(7);\n",
      "publish.mjs": 'await Bun.write("publish.log", "unexpected");\n',
    });
    repositories.push(repository);
    const logger = new MemoryLogger();

    expect(runRelease({
      cwd: repository.root,
      runner: repository.runner,
      prompt: new FixedPrompt(),
      logger,
    })).rejects.toThrow("Command failed");

    expect(await packageVersion(join(repository.root, "package.json"))).toBe("1.0.1");
    expect(await git(repository.runner, repository.root, ["tag", "--list", "v1.0.1"])).toBe("");
    expect(await git(repository.runner, repository.remote, ["show", "main:package.json"])).toContain(
      '"version": "1.0.0"',
    );
    expect(access(join(repository.root, "publish.log"))).rejects.toThrow();
    expect(logger.errors.join("\n")).toContain("changed but not committed");
  });

  test("reports a partial release and retry command when publishing fails", async () => {
    const repository = await createTestRepository({ publish: "bun ./fail-publish.mjs" }, {
      "fail-publish.mjs": "process.exit(9);\n",
    });
    repositories.push(repository);
    const logger = new MemoryLogger();

    expect(runRelease({
      cwd: repository.root,
      runner: repository.runner,
      prompt: new FixedPrompt(),
      logger,
    })).rejects.toThrow("Command failed");

    expect(await git(repository.runner, repository.remote, ["tag", "--list", "v1.0.1"])).toBe("v1.0.1");
    expect(await git(repository.runner, repository.remote, ["show", "main:package.json"])).toContain(
      '"version": "1.0.1"',
    );
    expect(logger.errors.join("\n")).toContain("publication is incomplete");
    expect(logger.errors.join("\n")).toContain("Retry: bun ./fail-publish.mjs");
  });

  test("publish-only runs no version or Git mutations", async () => {
    const repository = await createTestRepository({
      prepare: "bun ./prepare-retry.mjs",
      publish: "bun ./retry-publish.mjs",
    }, {
      "prepare-retry.mjs": `
        const file = Bun.file("prepare-count.log");
        const count = await file.exists() ? Number(await file.text()) : 0;
        await Bun.write(file, String(count + 1));
      `,
      "retry-publish.mjs": `
        if (!(await Bun.file("allow-publish.log").exists())) process.exit(9);
        await Bun.write("publish.log", "published");
      `,
    });
    repositories.push(repository);
    expect(runRelease({
      cwd: repository.root,
      runner: repository.runner,
      prompt: new FixedPrompt(),
      logger: new MemoryLogger(),
    })).rejects.toThrow("Command failed");
    await writeFile(join(repository.root, "allow-publish.log"), "retry\n");
    const prompt = new FixedPrompt();
    const before = await git(repository.runner, repository.root, ["rev-parse", "HEAD"]);

    const version = await runRelease({
      cwd: repository.root,
      runner: repository.runner,
      prompt,
      logger: new MemoryLogger(),
      publishOnly: true,
    });

    expect(version).toBe("1.0.1");
    expect(prompt.selections).toBe(0);
    expect(await git(repository.runner, repository.root, ["rev-parse", "HEAD"])).toBe(before);
    expect(await git(repository.runner, repository.root, ["tag", "--list"])).toBe("v1.0.1");
    expect(await readFile(join(repository.root, "publish.log"), "utf8")).toBe("published");
    expect(await readFile(join(repository.root, "prepare-count.log"), "utf8")).toBe("2");
  });

  test("publish-only rejects a version that has not been released", async () => {
    const repository = await createTestRepository({ publish: "bun ./publish.mjs" }, workflowFiles());
    repositories.push(repository);

    expect(runRelease({
      cwd: repository.root,
      runner: repository.runner,
      prompt: new FixedPrompt(),
      logger: new MemoryLogger(),
      publishOnly: true,
    })).rejects.toThrow("release tag v1.0.0 does not exist");
    expect(access(join(repository.root, "publish.log"))).rejects.toThrow();
  });

  test("tears down and restores a clean GitButler workspace", async () => {
    const repository = await createTestRepository({ publish: "bun ./publish.mjs" }, workflowFiles());
    repositories.push(repository);
    await git(repository.runner, repository.root, ["branch", "gitbutler/workspace"]);
    await git(repository.runner, repository.root, ["switch", "gitbutler/workspace"]);
    const runner = new ButlerTestRunner(repository.runner, repository.root);
    const logger = new MemoryLogger();

    await runRelease({
      cwd: repository.root,
      runner,
      prompt: new FixedPrompt(),
      logger,
    });

    expect(await git(repository.runner, repository.root, ["branch", "--show-current"])).toBe(
      "gitbutler/workspace",
    );
    expect(await git(repository.runner, repository.remote, ["show", "main:package.json"])).toContain(
      '"version": "1.0.1"',
    );
    expect(runner.commands).toContain("but teardown --checkout-to main");
    expect(runner.commands).toContain("but setup");
    expect(runner.commands).toContain("but pull");
    expect(logger.warnings.join("\n")).toContain("work-in-progress");
    expect(runner.commands.indexOf("but teardown --checkout-to main")).toBeLessThan(
      runner.commands.findIndex((command) => command.startsWith("git commit")),
    );
  });

  test("aborts a dirty worktree before asking for a version", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await writeFile(join(repository.root, "dirty.txt"), "dirty\n");
    const prompt = new FixedPrompt();

    expect(runRelease({
      cwd: repository.root,
      runner: repository.runner,
      prompt,
      logger: new MemoryLogger(),
    })).rejects.toThrow("worktree is not clean");
    expect(prompt.selections).toBe(0);
  });

  test("rejects preparation commands that stage extra files", async () => {
    const repository = await createTestRepository({ prepare: "bun ./stage.mjs" }, {
      "extra.txt": "initial\n",
      "stage.mjs": `
        await Bun.write("extra.txt", "changed\\n");
        const result = Bun.spawnSync(["git", "add", "extra.txt"]);
        process.exit(result.exitCode);
      `,
    });
    repositories.push(repository);
    const initialHead = await git(repository.runner, repository.root, ["rev-parse", "HEAD"]);

    expect(runRelease({
      cwd: repository.root,
      runner: repository.runner,
      prompt: new FixedPrompt(),
      logger: new MemoryLogger(),
    })).rejects.toThrow("must not modify the Git index");
    expect(await git(repository.runner, repository.root, ["rev-parse", "HEAD"])).toBe(initialHead);
    expect(await git(repository.runner, repository.root, ["tag", "--list"])).toBe("");
  });

  test("rejects an invalid tag before changing version files", async () => {
    const repository = await createTestRepository({ tagName: "invalid tag %s" });
    repositories.push(repository);

    expect(runRelease({
      cwd: repository.root,
      runner: repository.runner,
      prompt: new FixedPrompt(),
      logger: new MemoryLogger(),
    })).rejects.toThrow("not a valid Git ref");
    expect(await packageVersion(join(repository.root, "package.json"))).toBe("1.0.0");
  });

  test("rejects preparation commands that change HEAD", async () => {
    const repository = await createTestRepository({ prepare: "git commit --allow-empty -m unexpected" });
    repositories.push(repository);

    expect(runRelease({
      cwd: repository.root,
      runner: repository.runner,
      prompt: new FixedPrompt(),
      logger: new MemoryLogger(),
    })).rejects.toThrow("changed Git HEAD");
    expect(await git(repository.runner, repository.root, ["log", "-1", "--pretty=%s"])).toBe("unexpected");
    expect(await git(repository.runner, repository.root, ["tag", "--list"])).toBe("");
    expect(await git(repository.runner, repository.remote, ["show", "main:package.json"])).toContain(
      '"version": "1.0.0"',
    );
  });

  test("rejects an unknown GitButler status schema", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await git(repository.runner, repository.root, ["branch", "gitbutler/workspace"]);
    await git(repository.runner, repository.root, ["switch", "gitbutler/workspace"]);
    const runner = new ButlerTestRunner(repository.runner, repository.root, {});

    expect(runRelease({
      cwd: repository.root,
      runner,
      prompt: new FixedPrompt(),
      logger: new MemoryLogger(),
    })).rejects.toThrow("unsupported status schema");
    expect(runner.commands).not.toContain("but teardown --checkout-to main");
  });

  test("restores GitButler when the workspace config is not Landed", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await git(repository.runner, repository.root, ["branch", "gitbutler/workspace"]);
    await git(repository.runner, repository.root, ["switch", "gitbutler/workspace"]);
    await writeFile(
      join(repository.root, "release.config.ts"),
      'export default { commitMessage: "release %s" };\n',
    );
    await git(repository.runner, repository.root, ["add", "release.config.ts"]);
    await git(repository.runner, repository.root, ["commit", "-m", "Unlanded release config"]);
    const runner = new ButlerTestRunner(repository.runner, repository.root);

    expect(runRelease({
      cwd: repository.root,
      runner,
      prompt: new FixedPrompt(),
      logger: new MemoryLogger(),
    })).rejects.toThrow("differs between the GitButler workspace");
    expect(await git(repository.runner, repository.root, ["branch", "--show-current"])).toBe(
      "gitbutler/workspace",
    );
    expect(await git(repository.runner, repository.remote, ["show", "main:package.json"])).toContain(
      '"version": "1.0.0"',
    );
  });

  test("does not restore GitButler over a clean commit created by preparation", async () => {
    const repository = await createTestRepository({
      prepare: "git add package.json && git commit -m unexpected",
    });
    repositories.push(repository);
    await git(repository.runner, repository.root, ["branch", "gitbutler/workspace"]);
    await git(repository.runner, repository.root, ["switch", "gitbutler/workspace"]);
    const runner = new ButlerTestRunner(repository.runner, repository.root);
    const logger = new MemoryLogger();

    expect(runRelease({
      cwd: repository.root,
      runner,
      prompt: new FixedPrompt(),
      logger,
    })).rejects.toThrow("changed Git HEAD");
    expect(await git(repository.runner, repository.root, ["branch", "--show-current"])).toBe("main");
    expect(await git(repository.runner, repository.root, ["log", "-1", "--pretty=%s"])).toBe("unexpected");
    expect(runner.commands).not.toContain("but setup");
    expect(logger.errors.join("\n")).toContain("GitButler will not be restored");
  });
});
