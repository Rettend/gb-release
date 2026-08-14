import { access } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createJiti } from "jiti";
import { ReleaseError } from "./errors.js";
import type { ReleaseConfig, ResolvedReleaseConfig } from "./types.js";

const DEFAULT_CONFIG: ResolvedReleaseConfig = {
  target: {
    remote: "origin",
    branch: "main",
  },
  versionFiles: ["package.json"],
  prepare: [],
  publish: [],
  commitFiles: [],
  commitMessage: "chore: release v%s",
  tagName: "v%s",
};

export function defineConfig(config: ReleaseConfig): ReleaseConfig {
  return config;
}

function normalizeCommands(
  value: string | string[] | undefined,
  field: "prepare" | "publish",
): string[] {
  const commands = value === undefined ? [] : typeof value === "string" ? [value] : value;
  if (!Array.isArray(commands) || commands.some((command) => typeof command !== "string" || !command.trim())) {
    throw new ReleaseError(`Configuration field "${field}" must contain non-empty commands.`);
  }
  return commands.map((command) => command.trim());
}

function normalizePaths(value: string[] | undefined, field: string, defaults: string[]): string[] {
  const paths = value ?? defaults;
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string" || !path.trim())) {
    throw new ReleaseError(`Configuration field "${field}" must contain at least one path.`);
  }
  return [...new Set(paths.map((path) => path.trim().replaceAll("\\", "/")))];
}

function normalizeCommitPaths(value: string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((path) => typeof path !== "string" || !path.trim())) {
    throw new ReleaseError('Configuration field "commitFiles" must contain valid paths.');
  }
  return [...new Set(value.map((path) => path.trim().replaceAll("\\", "/")))];
}

function assertRepositoryPath(root: string, path: string, field: string): string {
  const absolutePath = resolve(root, path);
  const relativePath = relative(root, absolutePath);
  if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new ReleaseError(`Configuration field "${field}" contains a path outside the repository: ${path}`);
  }
  return absolutePath;
}

function nonEmptyString(value: unknown, fallback: string, field: string): string {
  const resolved = value ?? fallback;
  if (typeof resolved !== "string" || !resolved.trim()) {
    throw new ReleaseError(`Configuration field "${field}" must be a non-empty string.`);
  }
  return resolved.trim();
}

export async function loadConfig(
  root: string,
  configPath = "release.config.ts",
): Promise<ResolvedReleaseConfig> {
  const absoluteConfigPath = isAbsolute(configPath) ? configPath : resolve(root, configPath);
  assertRepositoryPath(root, absoluteConfigPath, "config");

  try {
    await access(absoluteConfigPath);
  } catch {
    throw new ReleaseError(`Release configuration not found: ${relative(root, absoluteConfigPath)}`);
  }

  let loaded: unknown;
  try {
    const jiti = createJiti(import.meta.url, {
      interopDefault: true,
      moduleCache: false,
      fsCache: false,
      tryNative: false,
    });
    loaded = await jiti.import(absoluteConfigPath, { default: true });
  } catch (error) {
    throw new ReleaseError(`Could not load ${relative(root, absoluteConfigPath)}.`, 1, {
      cause: error,
    });
  }

  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
    throw new ReleaseError("The release configuration must have a default object export.");
  }

  const config = loaded as ReleaseConfig;
  const versionFiles = normalizePaths(config.versionFiles, "versionFiles", DEFAULT_CONFIG.versionFiles);
  const commitFiles = normalizeCommitPaths(config.commitFiles);

  for (const path of versionFiles) assertRepositoryPath(root, path, "versionFiles");
  for (const path of commitFiles) assertRepositoryPath(root, path, "commitFiles");

  for (const path of versionFiles) {
    try {
      await access(resolve(root, path));
    } catch {
      throw new ReleaseError(`Version file does not exist: ${path}`);
    }
  }

  return {
    target: {
      remote: nonEmptyString(config.target?.remote, DEFAULT_CONFIG.target.remote, "target.remote"),
      branch: nonEmptyString(config.target?.branch, DEFAULT_CONFIG.target.branch, "target.branch"),
    },
    versionFiles,
    prepare: normalizeCommands(config.prepare, "prepare"),
    publish: normalizeCommands(config.publish, "publish"),
    commitFiles,
    commitMessage: nonEmptyString(config.commitMessage, DEFAULT_CONFIG.commitMessage, "commitMessage"),
    tagName: nonEmptyString(config.tagName, DEFAULT_CONFIG.tagName, "tagName"),
  };
}

export function formatTemplate(template: string, version: string): string {
  return template.replaceAll("%s", version);
}
