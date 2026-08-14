import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { inc, valid } from "semver";
import { ReleaseError } from "./errors.js";

interface VersionDocument {
  path: string;
  source: string;
  version: string;
}

function parseVersionFile(path: string, source: string): string {
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReleaseError(`Version file is not valid JSON or JSONC: ${path}`);
  }
  const version = (value as Record<string, unknown>).version;
  if (typeof version !== "string" || !valid(version)) {
    throw new ReleaseError(`Version file does not contain a valid semantic version: ${path}`);
  }
  return version;
}

async function readDocuments(root: string, paths: string[]): Promise<VersionDocument[]> {
  return await Promise.all(paths.map(async (path) => {
    const source = await readFile(resolve(root, path), "utf8");
    return { path, source, version: parseVersionFile(path, source) };
  }));
}

export async function readCurrentVersion(root: string, paths: string[]): Promise<string> {
  const documents = await readDocuments(root, paths);
  const currentVersion = documents[0]?.version;
  if (!currentVersion) {
    throw new ReleaseError("At least one version file is required.");
  }
  const mismatch = documents.find((document) => document.version !== currentVersion);
  if (mismatch) {
    const versions = documents.map((document) => `${document.path}: ${document.version}`).join("\n");
    throw new ReleaseError(`Configured version files do not agree:\n${versions}`);
  }
  return currentVersion;
}

function formattingOptions(source: string): {
  insertSpaces: boolean;
  tabSize: number;
  eol: string;
} {
  const indent = source.match(/\n([\t ]+)\S/u)?.[1] ?? "  ";
  return {
    insertSpaces: !indent.includes("\t"),
    tabSize: indent.includes("\t") ? 1 : indent.length,
    eol: source.includes("\r\n") ? "\r\n" : "\n",
  };
}

export async function updateVersionFiles(
  root: string,
  paths: string[],
  nextVersion: string,
): Promise<void> {
  if (!valid(nextVersion)) {
    throw new ReleaseError(`Invalid semantic version: ${nextVersion}`);
  }
  const documents = await readDocuments(root, paths);
  await Promise.all(documents.map(async (document) => {
    const edits = modify(document.source, ["version"], nextVersion, {
      formattingOptions: formattingOptions(document.source),
    });
    await writeFile(resolve(root, document.path), applyEdits(document.source, edits), "utf8");
  }));
}

export function versionChoices(currentVersion: string): {
  patch: string;
  minor: string;
  major: string;
} {
  const patch = inc(currentVersion, "patch");
  const minor = inc(currentVersion, "minor");
  const major = inc(currentVersion, "major");
  if (!patch || !minor || !major) {
    throw new ReleaseError(`Cannot increment semantic version: ${currentVersion}`);
  }
  return { patch, minor, major };
}
