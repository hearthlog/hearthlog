#!/usr/bin/env npx tsx
/**
 * Build and deploy one tenant's frontend Worker.
 *
 * This is the CI-native replacement for the per-tenant leg of the old
 * compensating transaction. It validates the bundle with a Wrangler dry-run,
 * then deploys. Roll back with Cloudflare's native per-Worker versions:
 *
 *   pnpm exec wrangler deployments list --config .generated/sites/<site>/wrangler.jsonc
 *   pnpm exec wrangler rollback <deployment-id> --config .generated/sites/<site>/wrangler.jsonc
 *
 * Usage:
 *   pnpm deploy:tenant -- --site st
 *   pnpm deploy:tenant -- --site st --dry-run
 *   pnpm deploy:tenant -- --site st --skip-build
 *
 * A site on its own stack (tenants/<id>/deployment.json) also deploys its own
 * public Gallery and calendar feed Workers after the frontend, because the
 * feed Worker binds to the frontend's renderer.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { relative } from "node:path";

import { buildTenant, frontendUnit, restoreGenerated, runWrangler } from "./deploy-runner.js";
import { buildGalleryPublic } from "../public-workers/build-gallery-public.js";
import { generateHostConfigs, hostWorkerConfigPath, hostWorkerDirectory } from "../tenants/host-configs.js";
import {
	loadTenantConfig,
	REPOSITORY_ROOT,
	siteById,
	type ResolvedSite,
} from "../tenants/tenant-config.js";
import { generateTenantWranglerConfigs } from "../tenants/wrangler-config.js";

interface Options {
	site: string;
	dryRun: boolean;
	skipBuild: boolean;
	help: boolean;
}

function usage(): string {
	return `Build and deploy one tenant frontend Worker.

Usage:
  pnpm deploy:tenant -- --site <id> [options]

Options:
  --site <id>                 Site id from tenants.json (required)
  --dry-run                   Build and bundle without uploading
  --skip-build                Deploy the existing build/<site> output
  -h, --help                  Show this help`;
}

export function parseOptions(argv: string[]): Options {
	const options: Options = {
		site: "",
		dryRun: false,
		skipBuild: false,
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
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--skip-build":
				options.skipBuild = true;
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

export async function deploySite(options: Options): Promise<void> {
	if (!options.site) throw new Error("--site requires a site id");
	const { sites } = await loadTenantConfig();
	const site = siteById(sites, options.site);

	// Generated tenant wrangler configs are derived from tenants.json.
	await generateTenantWranglerConfigs(site.id);

	// The build leaves the site's own catalog in `.generated/`, which its Worker bundles; the commands
	// that read every site's configuration run after it is restored.
	const unit = await frontendUnit(site.id);
	try {
		if (!options.skipBuild) {
			await buildTenant(site.id);
		}
		console.log(`\nValidating ${unit.label}...`);
		await runWrangler(unit.config, unit.envKey, ["deploy", "--dry-run"]);
		if (!options.dryRun) {
			console.log(`\nDeploying ${unit.label}...`);
			await runWrangler(unit.config, unit.envKey, ["deploy"]);
			console.log(`Deployed ${site.id}.`);
		}
	} finally {
		if (!options.skipBuild) await restoreGenerated();
	}

	if (options.dryRun) {
		await deployOwnPublicWorkers(site, true, options.skipBuild);
		console.log(`\nDry run complete for ${site.id}. Nothing was uploaded.`);
		return;
	}
	await deployOwnPublicWorkers(site, false, options.skipBuild);
}

/** The public Workers of a site on its own stack; shared sites use the shared ones. */
async function deployOwnPublicWorkers(site: ResolvedSite, dryRun: boolean, skipBuild: boolean): Promise<void> {
	if (!site.deployment) return;
	const args = ["deploy", ...(dryRun ? ["--dry-run"] : [])];
	if (site.features.includes("gallery")) {
		if (skipBuild) {
			// A release built elsewhere carries its Worker bundle; only the configs are written here.
			await generateHostConfigs(site.id);
			if (!existsSync(join(hostWorkerDirectory(site.id, "gallery-public"), "dist", "worker", "index.js"))) {
				throw new Error(`--skip-build needs the built public Gallery Worker: run hearthlog gallery-public:build --site ${site.id} first`);
			}
		} else {
			await buildGalleryPublic(site.id);
		}
		const config = relative(REPOSITORY_ROOT, hostWorkerConfigPath(site.id, "gallery-public"));
		console.log(`\n${dryRun ? "Validating" : "Deploying"} the ${site.id} public Gallery Worker...`);
		await runWrangler(config, null, args);
	}
	// Calendar is on for every site, so every site on its own stack has a feed Worker.
	await generateHostConfigs(site.id);
	const calendarConfig = relative(REPOSITORY_ROOT, hostWorkerConfigPath(site.id, "calendar-public"));
	console.log(`\n${dryRun ? "Validating" : "Deploying"} the ${site.id} calendar feed Worker...`);
	await runWrangler(calendarConfig, null, args);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const options = parseOptions(argv);
	if (options.help) {
		console.log(usage());
		return;
	}
	process.chdir(REPOSITORY_ROOT);
	await deploySite(options);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	main().catch((error: unknown) => {
		console.error(`\n${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
