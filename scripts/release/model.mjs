import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

export function version(value) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value ?? '')) {
        throw new Error(`Expected a stable version x.y.z, received ${JSON.stringify(value)}`);
    }
    const parts = value.split('.').map(Number);
    if (!parts.every(Number.isSafeInteger)) throw new Error(`Version components are too large: ${value}`);
    return parts;
}

export function compare(a, b) {
    const aa = version(a), bb = version(b);
    for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return Math.sign(aa[i] - bb[i]);
    return 0;
}

// Deliberately accepts the stable comparator/caret/tilde ranges used by these repositories.
// Unknown syntax fails closed rather than silently declaring an SDK compatible.
export function satisfies(target, range) {
    version(target);
    const alternatives = range.split('||');
    const results = alternatives.map((alternative) => {
        const tokens = alternative.trim().replace(/(>=|<=|>|<|=)\s+/g, '$1').split(/\s+/);
        return tokens.map((token) => {
            if (token === '*') return true;
            const match = /^(\^|~|>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(token);
            if (!match) throw new Error(`Unsupported version range ${JSON.stringify(range)}; update it explicitly before releasing`);
            const [, op = '=', base] = match;
            const order = compare(target, base);
            if (op === '^' || op === '~') {
                const [major, minor, patch] = version(base);
                const upper = op === '~' ? `${major}.${minor + 1}.0` : major ? `${major + 1}.0.0` : minor ? `0.${minor + 1}.0` : `0.0.${patch + 1}`;
                return order >= 0 && compare(target, upper) < 0;
            }
            return ({ '=': order === 0, '>': order > 0, '>=': order >= 0, '<': order < 0, '<=': order <= 0 })[op];
        }).every(Boolean);
    });
    return results.some(Boolean);
}

export function parseArgs(argv) {
    const options = { modules: {}, execute: false, merge: false, retryFailed: false };
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (['--execute', '--merge', '--retry-failed'].includes(arg)) {
            options[{ '--execute': 'execute', '--merge': 'merge', '--retry-failed': 'retryFailed' }[arg]] = true;
        } else if (['--config', '--tenant', '--core', '--module'].includes(arg)) {
            const value = argv[++i];
            if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
            if (arg === '--module') {
                const match = /^([a-z][a-z0-9-]*)@(.*)$/.exec(value);
                if (!match || options.modules[match[1]]) throw new Error(`Expected a unique name@version for --module: ${value}`);
                version(match[2]);
                options.modules[match[1]] = match[2];
            } else options[arg.slice(2)] = value;
        } else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
        else positional.push(arg);
    }
    const [kind, a, b, ...extra] = positional;
    if (kind === 'core' && a && !b) {
        if (options.core) throw new Error('Specify the core version only once');
        options.core = a;
    } else if (kind === 'module' && a && b) {
        if (!/^[a-z][a-z0-9-]*$/.test(a) || options.modules[a]) throw new Error(`Invalid or repeated module ${a}`);
        version(b);
        options.modules[a] = b;
    } else if (kind === 'tenant' && a && !b) {
        if (options.tenant) throw new Error('Specify the tenant only once');
        options.tenant = a;
        if (!options.core && !Object.keys(options.modules).length) throw new Error('Choose --core and/or --module name@version');
    } else throw new Error('Use core <version>, module <name> <version>, or tenant <id>');
    if (extra.length || !options.tenant) throw new Error('Choose a tenant with --tenant <id>');
    if (options.core) version(options.core);
    if (options.merge && !options.execute) throw new Error('--merge requires --execute');
    if (options.retryFailed && !options.execute) throw new Error('--retry-failed requires --execute');
    return { ...options, kind };
}

export function platformPackages(root) {
    return readdirSync(join(root, 'packages'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
        const directory = join(root, 'packages', entry.name);
        const manifest = readJson(join(directory, 'package.json'));
        return manifest.private ? [] : [{ directory, manifest }];
    });
}

export function lockedVersion(root, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    const match = new RegExp(`^      ['"]?${escaped}['"]?:\\n(?:        [^\\n]*\\n)*?        version: ['"]?(\\d+\\.\\d+\\.\\d+)(?=[('"\\s]|$)`, 'm').exec(lock);
    if (!match) throw new Error(`Cannot determine locked ${name} in ${root}; use --core x.y.z or update the lockfile`);
    return match[1];
}

export function updateModule(manifest, contract, target, platformNames, requested) {
    manifest = structuredClone(manifest);
    contract = structuredClone(contract);
    const changes = [];
    if (target) {
        for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
            for (const [name, range] of Object.entries(manifest[section] ?? {})) {
                if (!platformNames.includes(name) || satisfies(target, range)) continue;
                // Add only the version actually validated; do not promise an untested future release range.
                manifest[section][name] = `${range} || ${target}`;
                changes.push(`${section}.${name}: ${range} → ${manifest[section][name]}`);
            }
        }
    }
    const [major, minor, patch] = version(manifest.version);
    const next = requested ?? (changes.length ? `${major}.${minor}.${patch + 1}` : manifest.version);
    version(next);
    if (compare(next, manifest.version) < 0 || (changes.length && compare(next, manifest.version) <= 0)) {
        throw new Error(`${manifest.name}: dependency changes require a new version above ${manifest.version}`);
    }
    const changed = changes.length > 0 || !!requested;
    if (changed) manifest.version = contract.version = next;
    return { manifest, contract, changes, changed };
}

export function makePlan(config, options, paths) {
    const packages = platformPackages(paths.core);
    const platformNames = packages.map(({ manifest }) => manifest.name);
    const tenant = readJson(join(paths.tenant, 'package.json'));
    const target = options.core ?? lockedVersion(paths.tenant, '@hearthlog/sdk');
    if (options.kind === 'core') {
        const current = new Set(packages.map(({ manifest }) => manifest.version));
        if (current.size !== 1) throw new Error('Core package versions differ; reconcile them before release');
        if (compare(target, [...current][0]) <= 0) throw new Error(`Choose a new core version above ${[...current][0]}; use tenant --core to adopt published versions`);
    }
    const selected = [];
    for (const [alias, entry] of Object.entries(config.modules)) {
        const directory = paths.modules[alias];
        const manifest = readJson(join(directory, 'package.json'));
        const installed = manifest.name in (tenant.dependencies ?? {});
        if (!installed && options.modules[alias]) throw new Error(`${alias} is not installed by this tenant`);
        if (!installed) continue;
        const contract = readJson(join(directory, 'hearthlog.module.json'));
        const updated = options.kind === 'tenant'
            ? { manifest, contract, changes: [], changed: false }
            : updateModule(manifest, contract, options.core ? target : undefined, platformNames, options.modules[alias]);
        selected.push({ alias, ...entry, ...updated, directory, name: manifest.name, previous: lockedVersion(paths.tenant, manifest.name),
            version: options.kind === 'tenant' ? (options.modules[alias] ?? lockedVersion(paths.tenant, manifest.name))
                : updated.changed ? updated.manifest.version : lockedVersion(paths.tenant, manifest.name) });
    }
    for (const alias of Object.keys(options.modules)) if (!selected.some((item) => item.alias === alias)) throw new Error(`Unknown or uninstalled module ${alias}`);
    for (const name of Object.keys(tenant.dependencies ?? {})) {
        if (/@[^/]+\/module-/.test(name) && !selected.some((item) => item.name === name)) throw new Error(`Configure the installed module ${name} before releasing`);
    }
    return { kind: options.kind, core: target, publishCore: options.kind === 'core', platformNames, modules: selected,
        tenant: options.tenant, site: config.tenants[options.tenant].site ?? options.tenant };
}

export function printPlan(plan, log = console.log) {
    log(`Core ${plan.core}${plan.publishCore ? ' (publish through Release)' : ' (use published packages)'}`);
    for (const item of plan.modules) {
        log(`  ${item.alias}: ${item.previous} → ${item.version}${item.changed ? ' (release)' : plan.kind === 'tenant' ? ' (adopt published release)' : ' (keep published release)'}`);
        for (const change of item.changes) log(`    ${change}`);
    }
    log(`Tenant ${plan.tenant}: validate composition → dependency/lock PR → deploy and verify receipt`);
}
