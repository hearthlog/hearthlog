#!/usr/bin/env npx tsx
/**
 * `hearthlog plan` and `hearthlog apply`: provision one tenant from its tenant files.
 *
 *   pnpm hearthlog plan  --site jst [--json]   read-only: resources, steps, problems
 *   pnpm hearthlog apply --site jst --yes      create resources and deploy, resumably
 *   pnpm hearthlog apply --site st --yes --stop-before frontend   provision the stack, switch no traffic
 *
 * `apply` changes Cloudflare, so it needs `--yes` and a plan without problems.
 * It runs the deploy tools in order (`hearthlog ensure`, `deploy-ledger`, `deploy`), each of which is idempotent,
 * and records every finished step
 * in `.wrangler/tenants/<site>/receipt.json` (protected state, no secrets). A
 * second run skips finished steps, so credentials are minted once; nothing it
 * runs deletes a bucket, a Ledger, or an Access application, and it never
 * passes `--rotate-token`.
 *
 *   --skip-build     deploy the build output already in place (a release built by another job)
 *   --dry-run        run the tools' dry runs; changes nothing and records no receipt
 *   --no-bootstrap   refuse to create a Ledger token or signing key (implied in CI): first provisioning is local
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    ApplyError,
    newReceipt,
    parseReceipt,
    planDeployment,
    renderPlan,
    runApply,
    serializeReceipt,
    type DeploymentPlan,
    type PlanInput,
    type StepExecutor,
    type StepId,
    type TenantResources,
} from "@hearthlog/tooling";

import { loadModules, modulesForFeatures } from "../compose/compose-modules.js";
import { resolveDedicatedAdminToken } from "../deploy/dedicated-ledger.js";
import { isCi } from "../deploy/deploy-runner.js";
import {
    infrastructureFor,
    loadTenantConfig,
    REPOSITORY_ROOT,
    siteById,
    type InfrastructureDefinition,
    type ResolvedSite,
} from "../tenants/tenant-config.js";
import { moduleBindings } from "../tenants/wrangler-config.js";

export function receiptPath(siteId: string): string {
    return join(REPOSITORY_ROOT, ".wrangler", "tenants", siteId, "receipt.json");
}

function tenantResources(site: ResolvedSite, shared: InfrastructureDefinition): TenantResources {
    const own = infrastructureFor(site, shared);
    const keyed = own as unknown as Record<string, string | undefined>;
    return {
        ledgerWorker: own.ledgerWorker,
        buckets: moduleBindings(site.features, own).r2.map(({ binding, bucket_name }) => ({ binding, bucket: bucket_name })),
        calendarFeedsBucket: own.calendarFeedsBucket,
        calendarPublicWorker: own.calendarPublicWorker,
        publicWorkers: modulesForFeatures(loadModules(), site.features).flatMap(({ manifest }) => {
            const name = manifest.publicWorker ? keyed[`${manifest.publicWorker.name}PublicWorker`] : undefined;
            return name ? [name] : [];
        }),
    };
}

export async function buildPlan(siteId: string): Promise<DeploymentPlan> {
    const { infrastructure, sites } = await loadTenantConfig();
    const site = siteById(sites, siteId);
    const input: PlanInput = {
        site: {
            id: site.id,
            origin: site.hostname,
            features: site.features,
            authorizedEmails: site.authorizedEmails,
            ledgerAppName: site.ledgerAppName,
            deployment: site.deployment ? { resourcePrefix: site.deployment.resourcePrefix, accountId: site.deployment.accountId } : null,
        },
        modules: modulesForFeatures(loadModules(), site.features).map(({ manifest }) => ({ id: manifest.id, version: manifest.version })),
        resources: tenantResources(site, infrastructure),
        accessTeamDomain: infrastructureFor(site, infrastructure).accessTeamDomain,
        others: sites.filter((other) => other.id !== site.id).map((other) => ({ id: other.id, resources: tenantResources(other, infrastructure) })),
        // The shared stack holds every module's resources under the shared names.
        shared: infrastructure.ledgerWorker === "" ? undefined : tenantResources({ deployment: null, features: loadModules().flatMap(({ manifest }) => manifest.features.map((feature) => feature.id)) } as unknown as ResolvedSite, infrastructure),
    };
    return planDeployment(input);
}

const BIN = fileURLToPath(new URL("../../bin/hearthlog.mjs", import.meta.url));

/** Run another `hearthlog` command from this package, so a tenant repository needs none of this repository's scripts. */
function run(args: string[]): Promise<void> {
    return new Promise((resolveRun, reject) => {
        const child = spawn(process.execPath, [BIN, ...args], { cwd: REPOSITORY_ROOT, stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolveRun() : reject(new Error(`hearthlog ${args.join(" ")} exited with ${String(code)}`))));
    });
}

/** The origin must send an unauthenticated visitor to sign in, not serve the app. */
export async function checkProtected(origin: string, fetcher: typeof fetch = fetch): Promise<void> {
    const response = await fetcher(origin, { redirect: "manual" });
    if (response.status === 200) throw new Error(`${origin} answered 200 without signing in: the site is not protected`);
    if (![301, 302, 303, 307, 308, 401, 403].includes(response.status) && response.type !== "opaqueredirect") {
        throw new Error(`${origin} answered ${response.status}; expected a sign-in redirect or a refusal`);
    }
}

export interface ExecutorOptions {
    skipBuild?: boolean;
    dryRun?: boolean;
    /** Refuse to create a Ledger token or signing key; a run that has no administrator token for its Ledger stops. */
    noBootstrap?: boolean;
}

export function executorsFor(siteId: string, dedicated: boolean, options: ExecutorOptions = {}): Record<StepId, StepExecutor> {
    const site = ["--site", siteId];
    const dry = options.dryRun ? ["--dry-run"] : [];
    return {
        resources: () => run(["ensure", ...site, "--skip-ledger", "--skip-secrets", ...dry]),
        // The first deploy mints the administrator token and signing key; later ones only push code.
        ledger: async () => {
            const known = !dedicated || Boolean(await resolveDedicatedAdminToken(siteId));
            if (!known && options.noBootstrap) {
                throw new Error(
                    `No administrator token for the ${siteId} Ledger (set LEDGER_ADMIN_TOKEN_${siteId.toUpperCase().replace(/-/g, "_")}). ` +
                        "This run does not create credentials: provision the stack once with `hearthlog apply` on your machine.",
                );
            }
            await run(["deploy-ledger", ...site, ...(known ? [] : ["--bootstrap-secrets"]), ...dry]);
        },
        // Creates the application with the site's event policy and gives the gateway its token; an existing token is kept.
        "ledger-app": () => run(["ensure", ...site, ...dry]),
        frontend: () => run(["deploy", ...site, ...(options.skipBuild ? ["--skip-build"] : []), ...dry]),
        verify: async (step) => {
            const plan = await buildPlan(siteId);
            console.log(step.summary);
            if (!options.dryRun) await checkProtected(plan.origin);
        },
    };
}

async function loadReceipt(plan: DeploymentPlan) {
    try {
        return parseReceipt(await readFile(receiptPath(plan.siteId), "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return newReceipt(plan);
        throw error;
    }
}

async function main(argv: string[]): Promise<void> {
    const [command, ...rest] = argv.filter((argument) => argument !== "--");
    const flag = (name: string) => rest.includes(name);
    const siteIndex = rest.indexOf("--site");
    const siteId = siteIndex === -1 ? undefined : rest[siteIndex + 1]?.trim();
    if ((command !== "plan" && command !== "apply") || !siteId) {
        console.error("Usage: pnpm hearthlog plan --site <id> [--json]\n       pnpm hearthlog apply --site <id> --yes");
        process.exit(1);
    }
    const plan = await buildPlan(siteId);
    if (command === "plan") {
        process.stdout.write(flag("--json") ? `${JSON.stringify(plan, null, 2)}\n` : renderPlan(plan));
        process.exit(plan.problems.length ? 1 : 0);
    }
    process.stdout.write(renderPlan(plan));
    if (!flag("--yes")) {
        console.error("\nThis would change Cloudflare. Run again with --yes to apply.");
        process.exit(1);
    }
    const stopIndex = rest.indexOf("--stop-before");
    const stopBefore = stopIndex === -1 ? undefined : (rest[stopIndex + 1] as StepId | undefined);
    if (stopIndex !== -1 && !plan.steps.some((step) => step.id === stopBefore)) {
        console.error(`--stop-before needs one of: ${plan.steps.map((step) => step.id).join(", ")}`);
        process.exit(1);
    }
    const dryRun = flag("--dry-run");
    try {
        const result = await runApply(plan, {
            stopBefore,
            receipt: dryRun ? newReceipt(plan) : await loadReceipt(plan),
            executors: executorsFor(plan.siteId, plan.topology === "dedicated", {
                skipBuild: flag("--skip-build"),
                dryRun,
                noBootstrap: flag("--no-bootstrap") || isCi(),
            }),
            save: async (receipt) => {
                if (dryRun) return;
                const path = receiptPath(plan.siteId);
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, serializeReceipt(receipt), { mode: 0o600 });
            },
            log: (message) => console.log(`\n== ${message}`),
        });
        console.log(`\nApplied ${plan.siteId}: ran ${result.ran.join(", ") || "nothing"}; skipped ${result.skipped.join(", ") || "nothing"}.`);
    } catch (error) {
        if (error instanceof ApplyError) {
            console.error(`\n${error.message}\nRun the same command again to resume from there.`);
            process.exit(1);
        }
        throw error;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
