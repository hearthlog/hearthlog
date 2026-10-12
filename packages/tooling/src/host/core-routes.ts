/**
 * The host's own routes: the thin files every site shares. Each page renders a page of `@hearthlog/shell`,
 * and each loader re-declares the shell's `load` (a plain `export { load } from` makes SvelteKit's static
 * page-option analysis give up and import the module while building) next to the literal page options.
 * `pnpm build:generated` writes them into `.generated/routes/`, beside the composed module routes.
 */

export interface RouteFile {
    /** Relative to the routes directory. */
    path: string;
    content: string;
}

export const CORE_ROUTE_FILES: readonly RouteFile[] = [
    { path: "+error.svelte", content: "<script lang=\"ts\">\n    import ErrorPage from '@hearthlog/shell/pages/error/ErrorPage.svelte';\n</script>\n\n<ErrorPage />\n" },
    { path: "+layout.svelte", content: "<script lang=\"ts\">\n    import '../app.css';\n    import ShellLayout from '@hearthlog/shell/pages/layout/Layout.svelte';\n    // The tenant's composed modules: `hearthlog compose` writes this file; the shell does not know them.\n    import { attentionContributions, startModules } from './(modules)/startup';\n\n    let { data, children } = $props();\n</script>\n\n<ShellLayout {data} {children} startup={{ attentionContributions, startModules }} />\n" },
    { path: "+layout.ts", content: "import { load as shellLoad } from '@hearthlog/shell/pages/layout/load.js';\n\nexport const load = shellLoad;\n\nexport const ssr = false;\nexport const prerender = false;\n" },
    { path: "+page.svelte", content: "<p role=\"status\">Opening your last section\u2026</p>\n" },
    { path: "+page.ts", content: "import { load as shellLoad } from '@hearthlog/shell/pages/redirects/start.js';\n\nexport const load = shellLoad;\n\nexport const ssr = false;\nexport const prerender = false;\n" },
    { path: "calendar/+page.svelte", content: "<script lang=\"ts\">\n    import Page from '@hearthlog/shell/pages/calendar/Page.svelte';\n\n    let { data } = $props();\n</script>\n\n<Page {data} />\n" },
    { path: "calendar/+page.ts", content: "import { load as shellLoad } from '@hearthlog/shell/pages/calendar/load.js';\n\nexport const load = shellLoad;\n" },
    { path: "developer/+page.svelte", content: "<script lang=\"ts\">\n    import Page from '@hearthlog/shell/pages/developer/Page.svelte';\n\n    let { data } = $props();\n</script>\n\n<Page {data} />\n" },
    { path: "developer/+page.ts", content: "import { load as shellLoad } from '@hearthlog/shell/pages/developer/load.js';\n\nexport const load = shellLoad;\n" },
    { path: "entities/+page.svelte", content: "<script lang=\"ts\">\n    import Page from '@hearthlog/shell/pages/entities/Page.svelte';\n\n    let { data } = $props();\n</script>\n\n<Page {data} />\n" },
    { path: "entities/+page.ts", content: "import { load as shellLoad } from '@hearthlog/shell/pages/entities/load.js';\n\nexport const load = shellLoad;\n" },
    { path: "entities/[type]/+page.svelte", content: "<script lang=\"ts\">\n    import Page from '@hearthlog/shell/pages/entity/Page.svelte';\n\n    let { data } = $props();\n</script>\n\n<Page {data} />\n" },
    { path: "entities/[type]/+page.ts", content: "import { load as shellLoad } from '@hearthlog/shell/pages/entity/load.js';\n\nexport const load = shellLoad;\n" },
    { path: "history/+page.svelte", content: "<svelte:head><title>Opening history</title></svelte:head>\n\n<p class=\"sr-only\" role=\"status\">Opening history in the sidebar\u2026</p>\n" },
    { path: "history/+page.ts", content: "import { load as shellLoad } from '@hearthlog/shell/pages/redirects/history.js';\n\nexport const load = shellLoad;\n" },
    { path: "today/+page.ts", content: "import { load as shellLoad } from '@hearthlog/shell/pages/redirects/today.js';\n\nexport const load = shellLoad;\n\nexport const ssr = false;\nexport const prerender = false;\n" },
];

/** The URL paths the core routes serve; no module may take one. */
export const CORE_ROUTE_PATHS: readonly string[] = [...new Set(
    CORE_ROUTE_FILES.filter(({ path }) => /(^|\/)\+page\.(svelte|ts)$/.test(path)).map(({ path }) => {
        const directory = path.replace(/\/?\+page\.(svelte|ts)$/, '');
        return `/${directory}`;
    }),
)].sort();
