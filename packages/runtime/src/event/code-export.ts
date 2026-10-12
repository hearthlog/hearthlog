/**
 * Code Export
 * 
 * Generates TypeScript code for promoting dynamic entities to static.
 * This allows users to copy-paste into entity-definitions.ts.
 */

import type { EntityTypeRecord } from '../db/dynamic-ddl.js';
import type { DynamicFieldDefinition } from './meta-entity-types.js';

/**
 * Generate the static entity definition code for a dynamic entity type.
 * This code can be copy-pasted into entity-definitions.ts
 */
export function generateStaticDefinition(record: EntityTypeRecord): string {
    const fields = JSON.parse(record.fields_json) as DynamicFieldDefinition[];

    const fieldLines = fields.map(f => {
        const parts: string[] = [];
        parts.push(`name: '${f.name}'`);
        parts.push(`type: '${f.type}'`);

        // Only add payloadKey if different from name
        if (f.payloadKey && f.payloadKey !== f.name) {
            parts.push(`payloadKey: '${f.payloadKey}'`);
        }

        if (f.required) {
            parts.push('required: true');
        }

        if (f.default !== undefined) {
            // Format default value appropriately
            if (typeof f.default === 'string') {
                parts.push(`default: '${f.default}'`);
            } else {
                parts.push(`default: ${f.default}`);
            }
        }

        return `            { ${parts.join(', ')} },`;
    });

    return `    {
        name: '${record.name}',
        table: '${record.table_name}',
        fields: [
${fieldLines.join('\n')}
        ],
    },`;
}

/**
 * Generate the full entity-definitions.ts snippet with instructions
 */
export function generateExportSnippet(record: EntityTypeRecord): string {
    const definition = generateStaticDefinition(record);

    return `// Add this to ENTITY_DEFINITIONS array in packages/contracts/src/event/entity-definitions.ts
// Then run: pnpm generate:entities

${definition}

// After adding, create your custom UI at: src/routes/${record.name}s/+page.svelte`;
}
