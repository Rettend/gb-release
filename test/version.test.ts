import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCurrentVersion, updateVersionFiles, versionChoices } from "../src/version.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("version files", () => {
  test("updates JSON and JSONC while preserving comments and line endings", async () => {
    const root = await mkdtemp(join(tmpdir(), "gb-release-version-"));
    directories.push(root);
    await writeFile(join(root, "package.json"), '{\n  "version": "1.2.3"\n}\n');
    await writeFile(join(root, "jsr.jsonc"), '{\r\n\t// package version\r\n\t"version": "1.2.3",\r\n}\r\n');

    expect(await readCurrentVersion(root, ["package.json", "jsr.jsonc"])).toBe("1.2.3");
    await updateVersionFiles(root, ["package.json", "jsr.jsonc"], "1.3.0");

    expect(await readCurrentVersion(root, ["package.json", "jsr.jsonc"])).toBe("1.3.0");
    const jsonc = await readFile(join(root, "jsr.jsonc"), "utf8");
    expect(jsonc).toContain("// package version");
    expect(jsonc).toContain("\r\n");
    expect(jsonc).toContain('"version": "1.3.0"');
  });

  test("rejects disagreeing versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "gb-release-version-"));
    directories.push(root);
    await writeFile(join(root, "package.json"), '{"version":"1.0.0"}');
    await writeFile(join(root, "jsr.json"), '{"version":"2.0.0"}');

    expect(readCurrentVersion(root, ["package.json", "jsr.json"])).rejects.toThrow(
      "Configured version files do not agree",
    );
  });

  test("creates patch, minor, and major choices", () => {
    expect(versionChoices("1.4.6")).toEqual({
      patch: "1.4.7",
      minor: "1.5.0",
      major: "2.0.0",
    });
  });
});
