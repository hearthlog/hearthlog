#!/usr/bin/env npx tsx
/**
 * Validate and deploy the shared Ledger backend Worker.
 *
 *
 * Frontends bind to it through the `LEDGER` service binding, so this runs
 * before any tenant deploy. Durable Object class names, bindings, and the
 * SQLite-backed DO identities are deployment and data contracts — this only
 * pushes code, never state.
 *
 * With `--site <id>`, deploys that site's own Ledger instead (a site with
 * `tenants/<id>/deployment.json`). The first deploy of a new Ledger passes
 * `--bootstrap-secrets`: it generates the administrator token and the token
 * signing key, pushes them as Worker secrets, and keeps the administrator
 * token in `.wrangler/tenants/<id>/.admin-token`. Neither value is printed.
 *
 * Usage:
 *   pnpm deploy:ledger
 *   pnpm deploy:ledger -- --dry-run
 *   pnpm deploy:ledger -- --site jst --bootstrap-secrets
 *   pnpm deploy:ledger -- --site jst
 */

import { relative } from "node:path";

import { runWrangler } from "./deploy-runner.js";
import {
	hasStoredAdminToken,
	newLedgerSecrets,
	storeAdminToken,
	dedicatedAdminTokenPath,
	requireDedicated,
} from "./dedicated-ledger.js";
import { generateHostConfigs, hostWorkerConfigPath } from "../tenants/host-configs.js";
import { loadTenantConfig, REPOSITORY_ROOT, siteById } from "../tenants/tenant-config.js";


interface Options {
	site?: string;
	bootstrapSecrets: boolean;
	dryRun: boolean;
	help: boolean;
}

function usage(): string {
	return `Validate and deploy the Ledger backend Worker.

Usage:
  pnpm deploy:ledger [options]

Options:
  --site <id>                 Deploy the own Ledger of a site on its own stack
  --bootstrap-secrets         First deploy of a site's own Ledger: generate and
                              push its administrator token and signing key
  --dry-run                   Bundle the Worker without uploading
  -h, --help                  Show this help`;
}

export function parseOptions(argv: string[]): Options {
	const options: Options = {
		bootstrapSecrets: false,
		dryRun: false,
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		switch (argument) {
			case "--":
				break;
			case "--site": {
				const site = argv[index + 1]?.trim();
				if (!site) throw new Error("--site requires a site id");
				options.site = site;
				index += 1;
				break;
			}
			case "--bootstrap-secrets":
				options.bootstrapSecrets = true;
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				throw new Error(`Unknown option: ${argument}`);
		}
	}
	return options;
}

export async function deployLedger(options: Options): Promise<void> {
	if (options.site) {
		await deployDedicatedLedger(options.site, options);
		return;
	}
	if (options.bootstrapSecrets) throw new Error("--bootstrap-secrets requires --site <id>");
	process.chdir(REPOSITORY_ROOT);
	await generateHostConfigs("shared");
	await runWrangler(relative(REPOSITORY_ROOT, hostWorkerConfigPath("shared", "ledger")), null, [
		"deploy",
		...(options.dryRun ? ["--dry-run"] : []),
	]);
	console.log(
		options.dryRun
			? "\nLedger dry run complete. Nothing was uploaded."
			: "\nDeployed the Ledger backend.",
	);
}

async function deployDedicatedLedger(siteId: string, options: Options): Promise<void> {
	process.chdir(REPOSITORY_ROOT);
	const { infrastructure, sites } = await loadTenantConfig();
	const site = siteById(sites, siteId);
	requireDedicated(site);
	await generateHostConfigs(site.id);
	const config = relative(REPOSITORY_ROOT, hostWorkerConfigPath(site.id, "ledger"));
	if (options.bootstrapSecrets && await hasStoredAdminToken(site.id)) {
		throw new Error(
			`${dedicatedAdminTokenPath(site.id)} already exists, so this Ledger was bootstrapped. ` +
				"Rotating its signing key would invalidate every app token; deploy without --bootstrap-secrets.",
		);
	}
	await runWrangler(config, null, ["deploy", ...(options.dryRun ? ["--dry-run"] : [])]);
	if (options.dryRun) {
		console.log(`\nLedger dry run complete for ${site.id}. Nothing was uploaded.`);
		return;
	}
	if (options.bootstrapSecrets) {
		const secrets = newLedgerSecrets();
		// Keep the administrator token before pushing: a pushed token nobody holds is lost.
		await storeAdminToken(site.id, secrets.ADMIN_TOKEN);
		try {
			await runWrangler(config, null, ["secret", "bulk"], { input: `${JSON.stringify(secrets)}\n` });
		} catch (error) {
			throw new Error(
				`Pushing the Ledger secrets failed (${error instanceof Error ? error.message : String(error)}). ` +
					`Delete ${dedicatedAdminTokenPath(site.id)} and run again with --bootstrap-secrets.`,
			);
		}
		console.log(`Pushed ADMIN_TOKEN and TOKEN_SIGNING_KEY_CURRENT; the administrator token is in ${dedicatedAdminTokenPath(site.id)}.`);
	}
	console.log(`\nDeployed the ${site.id} Ledger.`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const options = parseOptions(argv);
	if (options.help) {
		console.log(usage());
		return;
	}
	await deployLedger(options);
}

if (process.argv[1]?.endsWith("deploy-ledger.ts")) {
	main().catch((error: unknown) => {
		console.error(`\n${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
