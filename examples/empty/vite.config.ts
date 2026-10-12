// The site's Vite configuration is the shared one; the import is a relative path because Vite's config
// loader cannot load TypeScript from a package by name.
import { hearthlogConfig } from './node_modules/@hearthlog/tooling/src/vite/config.ts';

export default hearthlogConfig();
