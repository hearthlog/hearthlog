#!/usr/bin/env npx tsx
/**
 * Offline evaluation of the category decision model (phase 0 of
 * docs/ai-decisions-plan.md).
 *
 * Reads a local JSON export of `{ name, amount, category }` rows, asks the
 * same question the Worker asks (same question builder and adapter), and prints
 * precision and coverage at the 0.9 and 0.5 thresholds, both for every row
 * and for the rows the history rule would not have settled.
 *
 * The export contains personal finance data: keep it under `.eval/`, which is
 * gitignored. Credentials come from the environment only
 * (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN with Workers AI access).
 *
 * Usage:
 *   pnpm ai:eval -- --input .eval/categories.json [--limit 300] [--raw]
 *
 * Export the rows in Developer with:
 *   SELECT name, amount, transaction_category AS category FROM transactions
 *   WHERE transaction_category NOT IN ('unknown', '')
 */

import { readFileSync } from "node:fs";

import { AUTO_APPLY_PROBABILITY, NO_OPTION, OFFER_PROBABILITY } from "@hearthlog/contracts/ai/capabilities";
import type { CategoryPickItem } from "../modules/finance/src/finance/category-pick.js";
import { categoryPick } from "../modules/finance/src/server/category-pick.js";
import { decide, DECISION_MODEL, type DecisionModelBinding } from "@hearthlog/cloudflare/ai/decision-model.js";

interface Row {
    name: string;
    amount: number;
    category: string;
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
};

const input = value("input");
if (!input) {
    console.error("Usage: pnpm ai:eval -- --input .eval/categories.json [--limit 300] [--raw]");
    process.exit(1);
}
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !token) {
    console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI) in the environment.");
    process.exit(1);
}

const normalize = (name: string) => name.trim().toLowerCase();

/** The history rule, leave-one-out: same name, at least 2 other rows, leading share at least 0.8. */
function settledByHistory(rows: Row[]): boolean[] {
    const byName = new Map<string, Map<string, number>>();
    for (const row of rows) {
        const counts = byName.get(normalize(row.name)) ?? new Map<string, number>();
        counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
        byName.set(normalize(row.name), counts);
    }
    return rows.map((row) => {
        const counts = new Map(byName.get(normalize(row.name)));
        counts.set(row.category, (counts.get(row.category) ?? 1) - 1);
        const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
        const lead = Math.max(0, ...counts.values());
        return total >= 2 && lead / total >= 0.8;
    });
}

const rest: DecisionModelBinding = {
    async run(model, body) {
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`Workers AI answered ${response.status}`);
        return ((await response.json()) as { result: unknown }).result;
    },
};

const rows = (JSON.parse(readFileSync(input, "utf8")) as Row[])
    .filter((row) => row.name?.trim() && row.category && row.category !== "unknown" && Number.isFinite(row.amount))
    .slice(0, Number(value("limit") ?? Infinity));
const settled = settledByHistory(rows);

const items: CategoryPickItem[] = rows.map((row, index) => ({
    id: String(index),
    name: row.name.trim(),
    amount: Math.abs(row.amount),
    direction: row.amount < 0 ? "expense" : "income",
}));

console.log(`Model ${DECISION_MODEL}; ${rows.length} rows, ${settled.filter(Boolean).length} settled by history.`);
const { decisions } = await decide(rest, items.map((item) => ({ id: item.id, ...categoryPick.question(item), options: categoryPick.options() })), {
    timeoutMs: 600_000,
    onRawResponse: flag("raw") ? (raw) => console.log("First raw response:", JSON.stringify(raw, null, 2)) : undefined,
});

function report(label: string, include: (index: number) => boolean): void {
    console.log(`\n${label}`);
    for (const threshold of [AUTO_APPLY_PROBABILITY, OFFER_PROBABILITY]) {
        let total = 0;
        let answered = 0;
        let correct = 0;
        decisions.forEach((decision, index) => {
            if (!include(index)) return;
            total += 1;
            if (decision.option === NO_OPTION || decision.probability < threshold) return;
            answered += 1;
            if (decision.option === rows[index].category) correct += 1;
        });
        const pct = (part: number, whole: number) => (whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)} %`);
        console.log(`  >= ${threshold}: coverage ${pct(answered, total)} (${answered}/${total}), precision ${pct(correct, answered)} (${correct}/${answered})`);
    }
}

report("All rows", () => true);
report("Rows the history rule would not have settled", (index) => !settled[index]);

const remaining = settled.filter((value) => !value).length;
console.log(`\nGo/no-go: at 0.9, precision >= 95 % on at least 100 unsettled rows (${remaining} here).`);
