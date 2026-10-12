#!/usr/bin/env npx tsx
/**
 * Tenant Config Check
 *
 * Validates tenants.json end to end and verifies the generated per-site
 * wrangler configs. The tenant files are the single source of truth.
 *
 * Usage: pnpm check:tenants
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { gatewayEntryPath, loadModules } from "../compose/compose-modules.js";
import {
    infrastructureFor,
    loadTenantConfig,
    validateCrossSite,
    validateDeploymentIsolation,
    REPOSITORY_ROOT,
    type InfrastructureDefinition,
    type ResolvedSite,
} from "../tenants/tenant-config.js";
import {
    buildTenantWranglerConfig,
    generateTenantWranglerConfigs,
    integrationsVariable,
    moduleBindings,
    serverDeclarations,
    siteIdentityVariables,
    siteBuildDirectory,
    siteConfigDirectory,
    sweepsSharedStack,
    workerFirstEntries,
    wranglerConfigPath,
} from "../tenants/wrangler-config.js";
import { WRANGLER_BASE } from "../tenants/wrangler-base.js";
import { generateHostConfigs, hostWorkerConfigPath } from "../tenants/host-configs.js";
import { moduleLockProblems } from "../tenants/module-lock.js";
import { isTenantSchemaCurrent } from "../tenants/tenant-schema.js";

function checkBase(): string[] {
    const problems: string[] = [];
    if (WRANGLER_BASE.assets.binding !== "ASSETS") problems.push('wrangler base: assets.binding must be "ASSETS"');
    if (WRANGLER_BASE.assets.run_worker_first[0] !== "/api/ledger") problems.push('wrangler base: assets.run_worker_first must keep "/api/ledger" first');
    if (WRANGLER_BASE.ai.binding !== "AI") problems.push("wrangler base: the AI binding is missing");
    return problems;
}

/** A site's config carries exactly the bindings, variables, and gateway table its modules declare. */
function checkModuleBindings(
    label: string,
    site: Pick<ResolvedSite, "id" | "features">,
    infrastructure: InfrastructureDefinition,
    config: { vars: Record<string, unknown>; r2Buckets: Array<Record<string, unknown>>; images: unknown; main: unknown; workerFirst?: readonly string[] },
): string[] {
    const problems: string[] = [];
    const expected = moduleBindings(site.features, infrastructure);
    for (const { binding, bucket_name } of expected.r2) {
        if (config.r2Buckets.find((bucket) => bucket.binding === binding)?.bucket_name !== bucket_name) {
            problems.push(`${label}: ${binding} bucket should be ${bucket_name}`);
        }
    }
    const everyModuleBinding = loadModules().flatMap(({ manifest }) => manifest.server?.bindings ?? []);
    const wanted = new Set(expected.r2.map((entry) => entry.binding));
    for (const { binding, type } of everyModuleBinding) {
        if (type === "r2" && !wanted.has(binding) && config.r2Buckets.some((bucket) => bucket.binding === binding)) {
            problems.push(`${label}: binds ${binding}, which none of its modules declare`);
        }
    }
    if (expected.images !== (typeof config.images === "object" && config.images !== null)) {
        problems.push(`${label}: the images binding ${expected.images ? "is missing" : "belongs to a module the site does not enable"}`);
    }
    for (const [name, value] of Object.entries(expected.vars)) {
        if (config.vars[name] !== value) problems.push(`${label}: vars.${name} should be ${value}`);
    }
    const everyVar = loadModules().flatMap(({ manifest }) => manifest.server?.vars ?? []);
    for (const { name } of everyVar) {
        if (!(name in expected.vars) && name in config.vars) problems.push(`${label}: vars.${name} belongs to a module the site does not enable`);
    }
    const entry = relative(siteConfigDirectory(site.id), gatewayEntryPath(site.id));
    if (typeof config.main !== "string" || config.main.replace(/^\.\//, "") !== entry) {
        problems.push(`${label}: main should be ./${entry}`);
    }
    // Every route a module serves must reach the Worker before the static assets.
    for (const entry of workerFirstEntries(serverDeclarations(site.features).flatMap((server) => server.routes ?? []))) {
        // A wildcard of a shorter prefix covers it (`/api/invoice-generation/*` covers `/api/invoice-generation/logs`).
        const covered = (config.workerFirst ?? []).some((have) => have === entry || (have.endsWith("/*") && entry.startsWith(have.slice(0, -1))));
        if (config.workerFirst && !covered) problems.push(`${label}: run_worker_first is missing ${entry}`);
    }
    return problems;
}

function checkGeneratedSite(
    site: ResolvedSite,
    infrastructure: InfrastructureDefinition,
    generated: Record<string, unknown>,
): string[] {
    const problems: string[] = [];
    const asRecord = (value: unknown) => (value ?? {}) as Record<string, unknown>;
    const label = `generated ${site.id}`;

    if (generated.name !== site.id) {
        problems.push(`${label}: name is ${JSON.stringify(generated.name)}`);
    }
    if (asRecord(generated.assets).directory !== relative(siteConfigDirectory(site.id), join(REPOSITORY_ROOT, siteBuildDirectory(site.id)))) {
        problems.push(
            `${label}: assets.directory is ${JSON.stringify(
                asRecord(generated.assets).directory,
            )}`,
        );
    }
    const vars = asRecord(generated.vars);
    if (vars.STOR_ADMIN_ENABLED !== String(site.admin)) {
        problems.push(`${label}: vars.STOR_ADMIN_ENABLED mismatch`);
    }
    if (vars.LEDGER_ADMIN_EMAIL !== infrastructure.ledgerAdminEmail) {
        problems.push(`${label}: vars.LEDGER_ADMIN_EMAIL mismatch`);
    }
    if (vars.STOR_AUTHORIZED_EMAILS !== site.authorizedEmails.join(",")) {
        problems.push(
            `${label}: vars.STOR_AUTHORIZED_EMAILS does not match the authorized email list`,
        );
    }
    if (vars.AI_CAPABILITIES !== site.ai.join(",")) {
        problems.push(`${label}: vars.AI_CAPABILITIES does not match the site's ai list`);
    }
    for (const [name, value] of Object.entries(siteIdentityVariables(site, infrastructure))) {
        if (vars[name] !== value) problems.push(`${label}: vars.${name} does not match tenants.json`);
    }
    if (vars.INTEGRATIONS !== integrationsVariable(site)) {
        problems.push(`${label}: vars.INTEGRATIONS does not match the site's integrations`);
    }
    if (asRecord(generated.ai).binding !== "AI") {
        problems.push(`${label}: AI binding is missing`);
    }
    const services = (generated.services ?? []) as Array<Record<string, unknown>>;
    if (
        services.find((service) => service.binding === "LEDGER")?.service !==
        infrastructure.ledgerWorker
    ) {
        problems.push(`${label}: LEDGER binding does not target the Ledger`);
    }
    const r2Buckets = (generated.r2_buckets ?? []) as Array<Record<string, unknown>>;
    problems.push(...checkModuleBindings(label, site, infrastructure, { vars, r2Buckets, images: generated.images, main: generated.main, workerFirst: (generated.assets as { run_worker_first?: string[] } | undefined)?.run_worker_first }));
    return problems;
}

const { infrastructure, sites, stacks } = await loadTenantConfig();
validateCrossSite(sites);
validateDeploymentIsolation(sites, infrastructure);

const problems: string[] = [...checkBase()];

// Generate every site's config and verify the content against the tenant files.
await generateTenantWranglerConfigs();
for (const site of sites) {
    const siteInfrastructure = infrastructureFor(site, infrastructure);
    const sweeps = sweepsSharedStack(stacks, infrastructure, site);
    const raw = readFileSync(wranglerConfigPath(site.id), "utf8");
    const generated = JSON.parse(raw) as Record<string, unknown>;
    problems.push(...checkGeneratedSite(site, siteInfrastructure, generated));
    const label = `generated ${site.id}`;
    const scheduled = serverDeclarations(site.features).some((server) => server.scheduled);
    // The shared stack's public copies are swept by one site; a site on its own stack sweeps its own.
    if (sweeps && scheduled && JSON.stringify(generated.triggers) !== JSON.stringify(WRANGLER_BASE.triggers)) {
        problems.push(`${label}: this site must sweep its public Gallery bucket (triggers)`);
    }
    if (!(sweeps && scheduled) && generated.triggers !== undefined) {
        problems.push(`${label}: only the site that owns the public Gallery bucket sweeps it`);
    }
    const expected = buildTenantWranglerConfig(site, siteInfrastructure, { sweeps });
    if (JSON.stringify(generated) !== JSON.stringify(expected)) problems.push(`${label}: the file differs from the builder output`);
}

// The Workers of each stack: the shared one (when a site uses it) and every site's own.
const stackNames = [...(stacks.some((stack) => stack.shared) ? ["shared"] : []), ...sites.filter((site) => site.deployment).map((site) => site.id)];
for (const stack of stackNames) {
    const siteInfrastructure = stack === "shared" ? infrastructure : infrastructureFor(sites.find((site) => site.id === stack)!, infrastructure);
    await generateHostConfigs(stack);
    const read = (worker: "ledger" | "calendar-public" | "gallery-public") => JSON.parse(readFileSync(hostWorkerConfigPath(stack, worker), "utf8")) as Record<string, unknown>;
    const label = `generated ${stack} stack`;
    if (read("ledger").name !== siteInfrastructure.ledgerWorker) problems.push(`${label}: the Ledger Worker should be named ${siteInfrastructure.ledgerWorker}`);
    const feedSites = (read("calendar-public").services as Array<{ service: string }>).map((service) => service.service).sort();
    const expectedSites = (stack === "shared" ? stacks.filter((entry) => entry.shared).map((entry) => entry.id) : [stack]).sort();
    if (JSON.stringify(feedSites) !== JSON.stringify(expectedSites)) problems.push(`${label}: the feed Worker should bind ${expectedSites.join(", ")}`);
    // A site on its own stack has a public Gallery Worker only when it ships the Gallery; the shared stack always has one.
    const ownSite = stack === "shared" ? undefined : sites.find((site) => site.id === stack)!;
    if ((!ownSite || ownSite.features.includes("gallery")) && read("gallery-public").name !== siteInfrastructure.galleryPublicWorker) problems.push(`${label}: the public Gallery Worker should be named ${siteInfrastructure.galleryPublicWorker}`);
}

for (const site of sites) problems.push(...(await moduleLockProblems(site)));

if (!(await isTenantSchemaCurrent())) {
    problems.push("tenants.schema.json is stale; run pnpm generate:tenant-schema");
}

if (problems.length > 0) {
    console.error("Tenant configuration is inconsistent:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
}

console.log(
    `Tenant configuration OK: ${sites.length} site(s) (${sites
        .map((site) => site.id)
        .join(", ")}), generated wrangler configs verified.`,
);
