/**
 * Shared deployment primitives for the CI-native pipelines.
 *
 * This replaces the former compensating-transaction machinery: it only runs
 * commands, invokes Wrangler, loads the deploy units, and builds one tenant
 * bundle. Rollback is delegated to Cloudflare's native per-Worker version
 * history (`wrangler deployments` / `wrangler rollback`).
 *
 * Wrangler authentication:
 *   - CI (`CI`/`GITHUB_ACTIONS`) uses CLOUDFLARE_API_TOKEN for deploys and
 *     secret pushes, exactly like the old single-Worker `deploy.yml`.
 *   - Local runs keep using the Wrangler OAuth session unless
 *     `STOR_WRANGLER_API_TOKEN=1` is set, because the local Access-only API
 *     token cannot push Worker secrets.
 */

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";

import { REPOSITORY_ROOT } from "../tenants/tenant-config.js";
import { resolveFrontendWranglerTarget, siteBuildDirectory } from "../tenants/wrangler-config.js";


export interface DeployUnit {
	/** Journal key: "backend" or the site id. */
	key: string;
	label: string;
	config: string;
	/** --env value; null means the config is standalone (no --env). */
	envKey: string | null;
	kind: "backend" | "frontend";
}

export interface RunCommandOptions {
	captureStdout?: boolean;
	env?: NodeJS.ProcessEnv;
	/** Written to the child's stdin and closed; used by `wrangler secret bulk`. */
	input?: string;
}

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

function quote(value: string): string {
	return /^[A-Za-z0-9_./:@%=-]+$/.test(value) ? value : JSON.stringify(value);
}

export function formatCommand(command: string, args: string[]): string {
	return [command, ...args].map(quote).join(" ");
}

/** Run a command, inheriting stdio unless stdout capture is requested. */
export async function runCommand(
	command: string,
	args: string[],
	options: RunCommandOptions = {},
): Promise<string> {
	const rendered = formatCommand(command, args);
	console.log(`\n$ ${rendered}`);

	return await new Promise<string>((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, {
			cwd: REPOSITORY_ROOT,
			env: options.env ?? process.env,
			stdio: [
				options.input === undefined ? "inherit" : "pipe",
				options.captureStdout ? "pipe" : "inherit",
				"inherit",
			],
		});
		let stdout = "";
		if (options.captureStdout && child.stdout) child.stdout.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		if (options.input !== undefined) child.stdin?.end(options.input);
		child.once("error", rejectPromise);
		child.once("exit", (code, signal) => {
			if (code === 0) {
				resolvePromise(stdout);
				return;
			}
			const reason = signal
				? `signal ${signal}`
				: `exit code ${code ?? "unknown"}`;
			rejectPromise(new Error(`Command failed with ${reason}: ${rendered}`));
		});
	});
}

/**
 * Run a command without rejecting on a non-zero exit, capturing both streams.
 * Used for idempotent provisioning calls that must distinguish "already
 * exists" from a real failure.
 */
export async function runCommandResult(
	command: string,
	args: string[],
	options: RunCommandOptions = {},
): Promise<CommandResult> {
	const rendered = formatCommand(command, args);
	console.log(`\n$ ${rendered}`);

	return await new Promise<CommandResult>((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, {
			cwd: REPOSITORY_ROOT,
			env: options.env ?? process.env,
			stdio: [
				options.input === undefined ? "inherit" : "pipe",
				"pipe",
				"pipe",
			],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		if (options.input !== undefined) child.stdin?.end(options.input);
		child.once("error", rejectPromise);
		child.once("exit", (code, signal) => {
			if (signal) {
				rejectPromise(
					new Error(`Command failed with signal ${signal}: ${rendered}`),
				);
				return;
			}
			resolvePromise({ code: code ?? -1, stdout, stderr });
		});
	});
}

export function isCi(): boolean {
	return Boolean(
		process.env.CI || process.env.GITHUB_ACTIONS || process.env.STOR_CI,
	);
}

/** Environment for Wrangler invocations. See the module header. */
export function wranglerEnvironment(
	overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { ...process.env, ...overrides };
	if (!isCi() && process.env.STOR_WRANGLER_API_TOKEN !== "1") {
		delete environment.CLOUDFLARE_API_TOKEN;
		delete environment.CLOUDFLARE_API_KEY;
		delete environment.CLOUDFLARE_API_EMAIL;
	}
	return environment;
}

/**
 * The project's own wrangler binary. Calling it directly (not through
 * `pnpm exec`) keeps `--env-file` away from pnpm's standalone executable,
 * which would read the flag as its own Node option and fail.
 */
export const WRANGLER_BIN = join(REPOSITORY_ROOT, "node_modules", ".bin", "wrangler");

export function wranglerArgs(
	config: string,
	envKey: string | null,
	args: string[],
): string[] {
	const tail = envKey === null ? [] : ["--env", envKey];
	return [
		...args,
		"--config",
		config,
		...tail,
		"--env-file",
		devNull,
	];
}

export async function runWrangler(
	config: string,
	envKey: string | null,
	args: string[],
	options: RunCommandOptions = {},
): Promise<string> {
	return await runCommand(WRANGLER_BIN, wranglerArgs(config, envKey, args), {
		...options,
		env: wranglerEnvironment(options.env),
	});
}

/** The wrangler target for one site, resolving generated tenant configs. */
export async function frontendUnit(siteId: string): Promise<DeployUnit> {
	const target = resolveFrontendWranglerTarget(siteId);
	return {
		key: siteId,
		label: `frontend ${siteId}`,
		config: target.config,
		envKey: target.envKey,
		kind: "frontend",
	};
}

/**
 * Build one tenant into its Wrangler `assets.directory`.
 *
 * `pnpm build` writes the site's catalog, tenant module, and app shell to
 * `.generated/` first, so the Worker bundles that site's modules; call
 * `restoreGenerated()` when the site's Wrangler commands are done. `kit.outDir` is left at the default
 * `.svelte-kit`. The old parallel transaction deploy also pointed SvelteKit's
 * outDir at an isolated directory; that made SvelteKit and `vite-plugin-pwa`
 * race over `output/client/service-worker.js` on a clean CI checkout, so it is
 * gone. One tenant builds per CI job / local invocation, so sharing the
 * default `.svelte-kit` is safe.
 */
export async function buildTenant(siteId: string): Promise<void> {
	const output = join(REPOSITORY_ROOT, siteBuildDirectory(siteId));
	await rm(output, { recursive: true, force: true });
	await runCommand("pnpm", ["build"], {
		env: {
			...process.env,
			VITE_STOR_TENANT: siteId,
		},
	});
}

/**
 * Build the default site's generated files again. A tenant build leaves `.generated/` with that site's
 * (smaller) catalog, and the tools that read every site's configuration need the default site's, which
 * covers them all.
 */
export async function restoreGenerated(): Promise<void> {
	const { VITE_STOR_TENANT: _site, ...environment } = process.env;
	await runCommand("pnpm", ["build:generated", "--quiet"], { env: environment });
}
