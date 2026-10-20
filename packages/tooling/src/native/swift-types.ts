/**
 * Swift for a module's native contract (`native.contract`): a `Codable` type for every argument and result schema and
 * a typed `EngineQuery` per function, all inside one enum named after the namespace. `hearthlog apple:types` writes it
 * to the manifest's `native.swiftTypes`; `hearthlog check-module` fails while it is stale.
 *
 * It reads the schemas as the JSON Schema TypeBox builds, and knows the subset a contract uses: objects, arrays,
 * records, strings, integers, numbers, booleans, string literal unions (Swift enums) and `T | null` (optionals).
 * A named schema (`$id`) becomes a type of that name; an unnamed one is named after where it appears.
 */

interface Schema {
    $id?: string;
    type?: string;
    const?: unknown;
    anyOf?: Schema[];
    items?: Schema;
    properties?: Record<string, Schema>;
    required?: string[];
    patternProperties?: Record<string, Schema>;
}

export interface ContractShape {
    namespace: string;
    version: number;
    queries: Readonly<Record<string, { args: unknown; result: unknown; depends: readonly string[] }>>;
}

export class SwiftTypesError extends Error {}

const KEYWORDS = new Set([
    'Any', 'as', 'associatedtype', 'break', 'case', 'catch', 'class', 'continue', 'default', 'defer', 'deinit', 'do',
    'else', 'enum', 'extension', 'fallthrough', 'false', 'fileprivate', 'for', 'func', 'guard', 'if', 'import', 'in',
    'init', 'inout', 'internal', 'is', 'let', 'nil', 'open', 'operator', 'private', 'protocol', 'public', 'repeat',
    'rethrows', 'return', 'self', 'Self', 'static', 'struct', 'subscript', 'super', 'switch', 'throw', 'throws', 'true',
    'try', 'Type', 'typealias', 'var', 'where', 'while',
]);

function words(text: string): string[] {
    return text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean);
}

export function pascalCase(text: string): string {
    return words(text).map((word) => word[0]!.toUpperCase() + word.slice(1)).join('');
}

export function camelCase(text: string): string {
    const pascal = pascalCase(text);
    return pascal ? pascal[0]!.toLowerCase() + pascal.slice(1) : pascal;
}

/** A Swift identifier for `name`: digits first get a leading underscore, keywords get backticks. */
function identifier(name: string): string {
    const safe = /^[0-9]/.test(name) ? `_${name}` : name;
    return KEYWORDS.has(safe) ? `\`${safe}\`` : safe;
}

function quote(text: string): string {
    return JSON.stringify(text);
}

/** The schema as plain JSON: TypeBox keeps its own bookkeeping under symbol keys, which this drops. */
function plain(schema: unknown): Schema {
    return JSON.parse(JSON.stringify(schema)) as Schema;
}

type Declaration = { kind: 'struct' | 'enum'; name: string; shape: string; code: string };

class Emitter {
    readonly declarations = new Map<string, Declaration>();

    constructor(private readonly namespace: string) {}

    /** The Swift type for `schema`; `hint` names it when it needs a declaration and has no `$id`. */
    type(schema: Schema, hint: string, path: string): string {
        if (schema.anyOf) {
            const options = schema.anyOf.filter((option) => option.type !== 'null');
            const optional = options.length < schema.anyOf.length;
            const base = options.length > 0 && options.every((option) => typeof option.const === 'string')
                ? this.enumeration(schema.$id ?? hint, options.map((option) => option.const as string), path)
                : options.length === 1
                    ? this.type(options[0]!, schema.$id ?? hint, path)
                    : (() => { throw new SwiftTypesError(`${path}: a union must be string literals, or one type and null`); })();
            return optional ? `${base}?` : base;
        }
        if (typeof schema.const === 'string') return 'String';
        switch (schema.type) {
            case 'string':
                return 'String';
            case 'integer':
                return 'Int';
            case 'number':
                return 'Double';
            case 'boolean':
                return 'Bool';
            case 'array':
                if (!schema.items) throw new SwiftTypesError(`${path}: an array needs items`);
                return `[${this.type(schema.items, `${hint}Item`, `${path}[]`)}]`;
            case 'object': {
                const pattern = Object.values(schema.patternProperties ?? {});
                if (pattern.length === 1 && !schema.properties) return `[String: ${this.type(pattern[0]!, `${hint}Value`, `${path}{}`)}]`;
                return this.structure(schema.$id ?? hint, schema, path);
            }
            default:
                throw new SwiftTypesError(`${path}: ${schema.type ?? 'this schema'} has no Swift type here`);
        }
    }

    private enumeration(name: string, values: string[], path: string): string {
        const cases = values.map((value) => {
            const swift = camelCase(value) || `value${pascalCase(value)}`;
            return swift === value ? `        case ${identifier(swift)}` : `        case ${identifier(swift)} = ${quote(value)}`;
        });
        const code = [`    enum ${name}: String, Codable, Hashable, Sendable, CaseIterable {`, ...cases, '    }'].join('\n');
        return this.declare({ kind: 'enum', name, shape: JSON.stringify(values), code }, path);
    }

    private structure(name: string, schema: Schema, path: string): string {
        const required = new Set(schema.required ?? []);
        const properties = Object.entries(schema.properties ?? {});
        const fields = properties.map(([key, property]) => {
            const swift = camelCase(key);
            if (!swift) throw new SwiftTypesError(`${path}.${key}: the key has no Swift name`);
            let type = this.type(property, `${name}${pascalCase(key)}`, `${path}.${key}`);
            if (!required.has(key) && !type.endsWith('?')) type = `${type}?`;
            return { key, swift, type };
        });
        const conformances = ['Codable', 'Equatable', 'Hashable', 'Sendable'];
        if (fields.some((field) => field.swift === 'id' && field.type === 'String')) conformances.push('Identifiable');
        const lines = [`    struct ${name}: ${conformances.join(', ')} {`, ...fields.map((field) => `        var ${identifier(field.swift)}: ${field.type}`)];
        if (fields.some((field) => field.swift !== field.key)) {
            lines.push('', '        enum CodingKeys: String, CodingKey {');
            for (const field of fields) {
                lines.push(field.swift === field.key ? `            case ${identifier(field.swift)}` : `            case ${identifier(field.swift)} = ${quote(field.key)}`);
            }
            lines.push('        }');
        }
        lines.push('    }');
        return this.declare({ kind: 'struct', name, shape: JSON.stringify(schema), code: lines.join('\n') }, path);
    }

    private declare(declaration: Declaration, path: string): string {
        if (!/^[A-Z][A-Za-z0-9]*$/.test(declaration.name)) throw new SwiftTypesError(`${path}: "${declaration.name}" is not a Swift type name`);
        const existing = this.declarations.get(declaration.name);
        if (existing && existing.shape !== declaration.shape) {
            throw new SwiftTypesError(`${path}: two different schemas are named ${declaration.name}`);
        }
        this.declarations.set(declaration.name, declaration);
        return `${pascalCase(this.namespace)}.${declaration.name}`;
    }
}

interface QueryNode {
    queries: Array<{ property: string; line: string }>;
    groups: Map<string, QueryNode>;
}

function renderGroup(node: QueryNode, indent: string): string[] {
    const lines = node.queries.map(({ line }) => `${indent}${line}`);
    for (const [name, child] of [...node.groups].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`${indent}enum ${name} {`, ...renderGroup(child, `${indent}    `), `${indent}}`);
    }
    return lines;
}

export function swiftTypes(contract: ContractShape, origin: { moduleId: string; contractFile: string }): string {
    const namespace = pascalCase(contract.namespace);
    const emitter = new Emitter(contract.namespace);
    const root: QueryNode = { queries: [], groups: new Map() };

    for (const name of Object.keys(contract.queries).sort()) {
        const query = contract.queries[name]!;
        const args = plain(query.args);
        const parts = name.split('.');
        const hint = pascalCase(parts.join(' '));
        const argumentsType = args.type === 'object' && Object.keys(args.properties ?? {}).length === 0 && !args.patternProperties
            ? 'NoArguments'
            : emitter.type(args, `${hint}Arguments`, `${name} arguments`);
        const resultType = emitter.type(plain(query.result), `${hint}Result`, `${name} result`);
        let node = root;
        for (const part of parts.slice(0, -1)) {
            const group = pascalCase(part);
            if (!node.groups.has(group)) node.groups.set(group, { queries: [], groups: new Map() });
            node = node.groups.get(group)!;
        }
        const property = identifier(camelCase(parts.at(-1)!));
        const depends = query.depends.map(quote).join(', ');
        node.queries.push({
            property,
            line: `static let ${property} = EngineQuery<${argumentsType}, ${resultType}>(name: ${quote(`${contract.namespace}.${name}`)}, depends: [${depends}])`,
        });
    }

    const declarations = [...emitter.declarations.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const group of root.groups.keys()) {
        if (emitter.declarations.has(group)) throw new SwiftTypesError(`${group} is both a type and a group of functions`);
    }
    return [
        `// AUTO-GENERATED by \`hearthlog apple:types\` from ${origin.moduleId} (${origin.contractFile}). Do not edit.`,
        '',
        'import Foundation',
        '',
        `/// ${origin.moduleId}'s native API, version ${contract.version}: \`engine.query(${namespace}.<function>, arguments)\`.`,
        `enum ${namespace} {`,
        `    static let namespace = ${quote(contract.namespace)}`,
        `    static let version = ${contract.version}`,
        '',
        ...renderGroup(root, '    '),
        '}',
        '',
        `extension ${namespace} {`,
        declarations.map((declaration) => declaration.code).join('\n\n'),
        '}',
        '',
    ].join('\n');
}
