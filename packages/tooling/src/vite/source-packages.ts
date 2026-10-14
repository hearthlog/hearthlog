import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

interface PackageManifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

function readManifest(directory: string): PackageManifest | undefined {
	try {
		return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as PackageManifest;
	} catch {
		return undefined;
	}
}

/** Node's lookup of `name` from `directory`: the nearest `node_modules/<name>` up the tree, as its real path. */
function packageDirectory(name: string, directory: string): string | undefined {
	for (let current = directory; ; current = dirname(current)) {
		const candidate = basename(current) === 'node_modules' ? join(current, name) : join(current, 'node_modules', name);
		if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
		if (dirname(current) === current) return undefined;
	}
}

/** The platform's packages and the modules (any package with a module manifest, whatever its scope) ship source. */
function shipsSource(name: string, directory: string): boolean {
	return name.startsWith('@hearthlog/') || existsSync(join(directory, 'hearthlog.module.json'));
}

/**
 * The packages a site installs that ship Svelte and TypeScript source instead of JavaScript: every `@hearthlog/*`
 * package and every module, direct or transitive. They are reached through the site's dependencies and, from each
 * of them, through their own (peer) dependencies, so a module's `@hearthlog/czech` or a private-scope module counts.
 */
export function sourcePackages(root = process.cwd()): string[] {
	const site = readManifest(root);
	if (!site) return [];
	const found = new Set<string>();
	const visited = new Set<string>();
	const visit = (names: Iterable<string>, from: string): void => {
		for (const name of names) {
			const directory = packageDirectory(name, from);
			if (!directory || !shipsSource(name, directory)) continue;
			found.add(name);
			if (visited.has(directory)) continue;
			visited.add(directory);
			const manifest = readManifest(directory);
			visit(Object.keys({ ...manifest?.dependencies, ...manifest?.peerDependencies, ...manifest?.optionalDependencies }), directory);
		}
	};
	visit(Object.keys({ ...site.dependencies, ...site.devDependencies }), resolve(root));
	return [...found].sort();
}
