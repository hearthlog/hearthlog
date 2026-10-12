import { getContext, setContext } from 'svelte';
const pageResourceContext = Symbol('page-resource');
type PageContext = { loading: boolean; error?: unknown; measurement?: { id: string } };
export function providePageResource(resource: () => PageContext): void {
    setContext(pageResourceContext, resource);
}
export function currentPageResource(): (() => PageContext) | undefined {
    return getContext(pageResourceContext);
}
