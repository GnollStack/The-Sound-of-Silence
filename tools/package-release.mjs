#!/usr/bin/env node
// Builds the release archive for The Sound of Silence from the committed runtime files.
//
//   node tools/package-release.mjs [--ref <commit>] [--output <path>]
//
// Writes dist/the-sound-of-silence.zip (or --output) plus dist/module.json next to it, using
// `git archive` so only tracked files under the release paths are included. Fails when the
// manifest's id, version, manifest URL, or download URL disagree with each other, when a runtime
// path listed by module.json is missing, or when a developer-only file would end up in the ZIP.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_ID = "the-sound-of-silence";
const REPOSITORY_URL = "https://github.com/GnollStack/The-Sound-of-Silence";
const RELEASE_PATHS = ["module.json", "LICENSE.txt", "README.md", "scripts", "styles", "templates"];
const FORBIDDEN_ENTRY = /^(tests|tools|dist|node_modules|\.github|\.git)(\/|$)|^(\.gitignore|\.gitattributes|package\.json|package-lock\.json|jsconfig\.json|\.env)$/i;

function git(args, options = {}) {
    return execFileSync("git", args, { cwd: ROOT, encoding: options.encoding ?? "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function parseArguments(argv) {
    const result = { ref: "HEAD", output: path.join(ROOT, "dist", `${MODULE_ID}.zip`) };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--ref" || argument === "--output") {
            const value = argv[index + 1];
            if (!value) throw new Error(`${argument} requires a value.`);
            if (argument === "--ref") result.ref = value;
            else result.output = path.resolve(ROOT, value);
            index += 1;
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    return result;
}

function manifestPaths(manifest) {
    const paths = [...(manifest.esmodules ?? []), ...(manifest.scripts ?? [])];
    for (const style of manifest.styles ?? []) paths.push(typeof style === "string" ? style : style?.src);
    for (const language of manifest.languages ?? []) paths.push(language?.path);
    for (const pack of manifest.packs ?? []) paths.push(pack?.path);
    for (const key of ["license", "readme", "changelog"]) {
        const value = manifest[key];
        if (typeof value === "string" && value && !/^https?:/i.test(value)) paths.push(value);
    }
    return paths.filter(Boolean).map(value => String(value).replace(/^\.\//, ""));
}

function validateManifest(manifest) {
    const failures = [];
    if (manifest.id !== MODULE_ID) failures.push(`module.json id must be ${MODULE_ID}.`);
    const version = String(manifest.version ?? "");
    if (!/^\d+\.\d+\.\d+$/.test(version)) failures.push(`module.json version '${version}' must be numeric X.Y.Z.`);
    const expectedManifest = `${REPOSITORY_URL}/releases/latest/download/module.json`;
    const expectedDownload = `${REPOSITORY_URL}/releases/download/V${version}/${MODULE_ID}.zip`;
    if (manifest.manifest !== expectedManifest) failures.push(`module.json manifest must be ${expectedManifest}`);
    if (manifest.download !== expectedDownload) failures.push(`module.json download must be ${expectedDownload} (update it when the version changes).`);
    return failures;
}

function main() {
    const { ref, output } = parseArguments(process.argv.slice(2));
    const commit = git(["rev-parse", `${ref}^{commit}`]).trim();
    const manifestText = git(["show", `${commit}:module.json`]);
    const manifest = JSON.parse(manifestText.replace(/^﻿/, ""));
    const failures = validateManifest(manifest);

    const tracked = git(["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", commit, "--", ...RELEASE_PATHS])
        .split(/\r?\n/).filter(Boolean);
    if (tracked.length === 0) failures.push("No tracked files matched the release paths.");
    for (const entry of tracked) {
        if (FORBIDDEN_ENTRY.test(entry)) failures.push(`Developer-only file would ship: ${entry}`);
    }
    for (const runtimePath of manifestPaths(manifest)) {
        if (!tracked.includes(runtimePath)) failures.push(`module.json references ${runtimePath}, which is not among the committed release files.`);
    }
    const workingManifestPath = path.join(ROOT, "module.json");
    if (existsSync(workingManifestPath)) {
        const working = JSON.parse(readFileSync(workingManifestPath, "utf8").replace(/^﻿/, ""));
        if (JSON.stringify(working) !== JSON.stringify(manifest)) {
            failures.push(`module.json in the working tree differs from ${ref}; commit it before packaging.`);
        }
    }
    if (failures.length) throw new Error(`Release contract failed:\n- ${failures.join("\n- ")}`);

    mkdirSync(path.dirname(output), { recursive: true });
    rmSync(output, { force: true });
    git(["archive", "--format=zip", `--output=${output}`, commit, "--", ...RELEASE_PATHS], { encoding: "buffer" });
    const standaloneManifest = path.join(path.dirname(output), "module.json");
    writeFileSync(standaloneManifest, manifestText);

    const archive = readFileSync(output);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    console.log(JSON.stringify({
        success: true,
        ref,
        commit,
        version: manifest.version,
        output,
        standaloneManifest,
        entries: tracked.length,
        bytes: archive.byteLength,
        sha256,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
}
