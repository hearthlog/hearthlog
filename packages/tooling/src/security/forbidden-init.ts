#!/usr/bin/env npx tsx
/**
 * Writes a first forbidden-identities file from the identities already in this repository's git
 * history (`packages/tooling/src/security/forbidden-identities.ts` describes the file).
 *
 * Every author and committer address except your personal one, GitHub and tool `noreply`
 * addresses, and bots becomes an entry, together with the domain's name when it is not a free
 * mail provider (so a company name in a file is caught as well as its addresses). Nothing is
 * printed except counts and the path: open the file to review it, and add what history cannot
 * know (company names, tax numbers) with `--add`.
 *
 * Usage: pnpm audit:forbidden:init [--personal <email>] [--add <string>]... [--force]
 *
 * The personal address defaults to the global `git config user.email`. The file is written with
 * mode 0600 and is never overwritten without `--force`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { forbiddenListPath, parseForbiddenList } from "./forbidden-identities.js";

const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "gmx.com", "gmx.net", "gmx.de", "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com", "yahoo.com", "proton.me", "protonmail.com", "seznam.cz", "email.cz", "centrum.cz", "post.cz"]);
const NOT_A_PERSON = /(?:noreply|no-reply|\[bot\]|users\.noreply\.github\.com|^bot@)/i;

export interface Identity {
    name: string;
    email: string;
}

/** Candidate entries from history identities: addresses plus the name of a non-free-mail domain. */
export function candidateEntries(identities: readonly Identity[], personal: string): { entries: string[]; addresses: number; names: number } {
    const entries = new Set<string>();
    let addresses = 0;
    let names = 0;
    for (const { name, email } of identities) {
        const address = email.trim().toLowerCase();
        if (!address.includes("@") || address === personal.toLowerCase() || NOT_A_PERSON.test(address) || NOT_A_PERSON.test(name)) continue;
        if (!entries.has(address)) addresses += 1;
        entries.add(address);
        const domain = address.split("@")[1]!;
        if (FREE_MAIL.has(domain)) continue;
        const label = domain.split(".").slice(0, -1).pop() ?? "";
        if (label.length >= 4 && !entries.has(label)) {
            entries.add(label);
            names += 1;
        }
    }
    return { entries: [...entries], addresses, names };
}

function git(args: string[], cwd?: string): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2).filter((argument) => argument !== "--");
    const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    const personal = value("--personal") ?? git(["config", "--global", "user.email"]).trim();
    if (!personal.includes("@")) {
        console.error("Pass your personal address with --personal <email>, or set the global git user.email to it.");
        process.exit(1);
    }
    const path = forbiddenListPath();
    if (existsSync(path) && !args.includes("--force")) {
        console.error(`${path} exists. Edit it, or pass --force to replace it.`);
        process.exit(1);
    }
    const log = git(["log", "--all", "--format=%an%x1f%ae%x1e%cn%x1f%ce%x1e"]);
    const identities = log
        .split("\x1e")
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => {
            const [name = "", email = ""] = record.split("\x1f");
            return { name, email };
        });
    const { entries, addresses, names } = candidateEntries(identities, personal);
    const added = args.flatMap((argument, index) => (argument === "--add" && args[index + 1] ? [args[index + 1]!] : []));
    const file = { forbidden: [...new Set([...entries, ...added])], allowedAuthorEmails: [personal.toLowerCase()] };
    parseForbiddenList(JSON.stringify(file), path); // refuse to write what the loader would reject
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    console.log(`Wrote ${path}: ${addresses} address(es) and ${names} domain name(s) from history, ${added.length} added by hand.`);
    console.log("Open the file to review it. Nothing was printed from it.");
}
