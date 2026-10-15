#!/usr/bin/env npx tsx
/**
 * The gate before anything is pushed to a public repository (plan, section 4, rule 7).
 *
 * Run it on the exact directory you are about to push: a snapshot with its first commit made, or
 * a module or platform clone. It reads the forbidden-identities file
 * (`packages/tooling/src/security/forbidden-identities.ts`) and fails when
 *
 *   - any file name, file content, or binary file contains a forbidden value;
 *   - the directory has git history and any commit's author or committer is not one of the
 *     allowed author addresses (GitHub's own `noreply` addresses are accepted);
 *   - any commit message, tag, or branch name contains a forbidden value, or any commit's diff does;
 *   - the repository's own git identity (`user.email`) is not an allowed address.
 *
 * Nothing it prints is a value from the list: findings name an entry by number.
 *
 * Usage: pnpm audit:push -- <directory> [--json]   (exit 1 unless the directory is clean)
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { forbiddenIn, forbiddenInBytes, forbiddenLabel, loadForbiddenList, maskForbidden, type ForbiddenList } from "./forbidden-identities.js";

export interface PushFinding {
    where: string;
    kind: string;
    detail: string;
}

const SAFE_NOREPLY = /^(?:noreply@github\.com|[0-9]*\+?[a-z0-9-]+(?:\[bot\])?@users\.noreply\.github\.com)$/i;

/** Every file under the directory except `.git`, as relative paths. */
export function listFiles(directory: string): string[] {
    // In a repository, what could be pushed is what git tracks or would add: an ignored `node_modules` is not part of it.
    if (existsSync(join(directory, ".git"))) {
        const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: directory, maxBuffer: 256 * 1024 * 1024 });
        return [...new Set(listed.toString("utf8").split("\0").filter(Boolean))].filter((file) => existsSync(join(directory, file)));
    }
    const files: string[] = [];
    const walk = (current: string) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            if (entry.name === ".git") continue;
            const path = join(current, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.isFile()) files.push(relative(directory, path));
        }
    };
    walk(directory);
    return files;
}

export function auditFiles(directory: string, list: ForbiddenList): PushFinding[] {
    const findings: PushFinding[] = [];
    for (const file of listFiles(directory)) {
        const shown = maskForbidden(file, list.forbidden);
        for (const entry of forbiddenIn(file, list.forbidden)) findings.push({ where: shown, kind: "file-name", detail: forbiddenLabel(entry) });
        const path = join(directory, file);
        if (lstatSync(path).size > 64 * 1024 * 1024) {
            findings.push({ where: shown, kind: "too-large-to-scan", detail: "larger than 64 MiB" });
            continue;
        }
        for (const entry of forbiddenInBytes(readFileSync(path), list.forbidden)) findings.push({ where: shown, kind: "content", detail: forbiddenLabel(entry) });
    }
    return findings;
}

function git(directory: string, args: string[]): string {
    return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** Authors, committers, messages, refs, diffs, and the repository's own identity. */
export function auditHistory(directory: string, list: ForbiddenList): PushFinding[] {
    const findings: PushFinding[] = [];
    if (!existsSync(join(directory, ".git"))) return findings;
    const allowed = new Set(list.allowedAuthorEmails);
    const isAllowed = (email: string) => allowed.has(email.toLowerCase()) || SAFE_NOREPLY.test(email);

    let log = "";
    try {
        log = git(directory, ["log", "--all", "--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e"]);
    } catch {
        // A repository without commits has nothing to check yet.
    }
    for (const record of log.split("\x1e").map((entry) => entry.trim()).filter(Boolean)) {
        const [commit = "", authorName = "", authorEmail = "", committerName = "", committerEmail = "", message = ""] = record.split("\x1f");
        const where = `commit ${commit.slice(0, 10)}`;
        if (!isAllowed(authorEmail)) findings.push({ where, kind: "author-not-allowed", detail: "author address is not in allowedAuthorEmails" });
        if (!isAllowed(committerEmail)) findings.push({ where, kind: "committer-not-allowed", detail: "committer address is not in allowedAuthorEmails" });
        for (const entry of forbiddenIn([authorName, authorEmail, committerName, committerEmail, message].join("\n"), list.forbidden)) {
            findings.push({ where, kind: "commit-metadata", detail: forbiddenLabel(entry) });
        }
    }
    const refs = git(directory, ["for-each-ref", "--format=%(refname)%09%(taggername)%09%(taggeremail)%09%(contents)"]);
    for (const entry of forbiddenIn(refs, list.forbidden)) findings.push({ where: "refs and tags", kind: "ref-metadata", detail: forbiddenLabel(entry) });
    let patches = "";
    try {
        patches = git(directory, ["log", "--all", "-p", "--format=", "--no-color"]);
    } catch {
        // No commits.
    }
    for (const entry of forbiddenIn(patches, list.forbidden)) findings.push({ where: "history diffs", kind: "history-content", detail: forbiddenLabel(entry) });

    let identity = "";
    try {
        identity = git(directory, ["config", "user.email"]).trim();
    } catch {
        // None configured: the commit would fail, which is the safe outcome.
    }
    if (identity && !isAllowed(identity)) findings.push({ where: "git config", kind: "identity-not-allowed", detail: "user.email in this repository is not in allowedAuthorEmails" });
    return findings;
}

export function auditPush(directory: string, list: ForbiddenList = loadForbiddenList()): PushFinding[] {
    if (list.allowedAuthorEmails.length === 0) {
        return [{ where: list.path, kind: "no-allowed-authors", detail: '"allowedAuthorEmails" must list the address commits may carry' }];
    }
    return [...auditFiles(directory, list), ...auditHistory(directory, list)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2).filter((argument) => argument !== "--");
    const directory = args.find((argument) => !argument.startsWith("--"));
    if (!directory || !existsSync(directory)) {
        console.error("Usage: pnpm audit:push -- <directory> [--json]");
        process.exit(1);
    }
    const root = resolve(directory);
    const findings = auditPush(root);
    const history = existsSync(join(root, ".git")) ? "with git history" : "no git history yet (make the first commit under the personal identity, then run this again)";
    if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify({ directory: root, findings }, null, 2)}\n`);
    } else {
        for (const finding of findings.slice(0, 40)) console.log(`${finding.where}: ${finding.kind}: ${finding.detail}`);
        if (findings.length > 40) console.log(`… ${findings.length - 40} more`);
        console.log(`\n${findings.length} finding(s) in ${root}, ${history}.`);
    }
    process.exit(findings.length ? 1 : 0);
}
