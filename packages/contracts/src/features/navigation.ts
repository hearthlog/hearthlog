import { FEATURES, ENTITIES_META, DEVELOPER_META, type FeatureId, type NavGroupName } from './registry';
import { MODULE_FEATURES, MODULE_ROUTES, MODULE_SECTIONS } from '#generated/modules';

export interface NavigationConfig {
    features: ReadonlySet<FeatureId>;
    entitiesNavVisible: boolean;
    developerNavVisible: boolean;
}
export interface Destination {
    id: FeatureId | 'entities' | 'developer';
    path: string;
    label: string;
    subtitle: string;
    keywords: string;
    group: NavGroupName;
    matchPaths?: string[];
    mobilePrimary?: boolean;
    mobileOrder?: number;
    /** Sub-pages the sidebar lists under the active section. */
    children?: NavChild[];
    /** The module section this destination stands for, which supplies its icon. */
    section?: string;
}
export interface NavChild {
    id: string;
    label: string;
    /** Route of the sub-page; a query-only child keeps the section's current path. */
    href: string;
    /** Query parameter value that selects this child (`tab=…`), or null for the default. */
    tab?: string | null;
    /** Attention badge id (`badgeFor`) for work that lives on this sub-page. */
    badgeId?: string;
}
const FEATURE_CHILDREN: Partial<Record<FeatureId, NavChild[]>> = {
    ...Object.fromEntries(MODULE_FEATURES.filter((feature) => feature.children?.length).map((feature) => [feature.id, feature.children])),
};
/** A visible place inside a module section (for example Health's Day, Body, Nutrition). */
export interface SectionLink {
    id: string;
    label: string;
    href: string;
    feature: string | null;
    secondary: boolean;
}

/** Whether a module route's feature requirement holds; routes without one always pass. */
export function moduleRouteAllowed(path: string, features: ReadonlySet<string>): boolean {
    const requires = MODULE_ROUTES.find((route) => route.path === path)?.requires;
    if (!requires) return true;
    return requires.features.filter((feature) => features.has(feature)).length >= (requires.minimum ?? 1);
}

/** A module section's places the tenant can open, in the section's order. */
export function sectionLinks(sectionId: string, features: ReadonlySet<string>): SectionLink[] {
    const section = MODULE_SECTIONS.find((candidate) => candidate.id === sectionId);
    if (!section) return [];
    return section.children
        .filter((child) => child.feature ? features.has(child.feature) : moduleRouteAllowed(child.requiresRoute!, features))
        .map((child) => ({ id: child.id, label: child.label, href: child.href, feature: child.feature ?? null, secondary: child.secondary ?? false }));
}

const SECTION_BY_FEATURE = new Map(MODULE_SECTIONS.flatMap((section) =>
    section.children.flatMap((child) => child.feature ? [[child.feature, section] as const] : [])));

export function buildNavigation(config: NavigationConfig) {
    // Features declare their place (`navOrder`); one that declares none comes last, in registration order.
    const place = (id: string) => FEATURES.find((feature) => feature.id === id)?.page?.navOrder ?? Number.MAX_SAFE_INTEGER;
    const registeredOrder = FEATURES.map((feature) => feature.id).sort((a, b) => place(a) - place(b));
    const destinations: Destination[] = registeredOrder.flatMap((id): Destination[] => {
        if (!config.features.has(id)) return [];
        const meta = FEATURES.find((feature) => feature.id === id)!.page!;
        // A module section (Health) is one destination for several features: it
        // opens on its first visible place, and the first enabled feature owns it.
        const section = SECTION_BY_FEATURE.get(id);
        if (section) {
            const links = sectionLinks(section.id, config.features);
            if (id !== links.find((link) => link.feature !== null)?.feature) return [];
            return [{ id, ...meta, group: section.navGroup, label: section.label, path: links[0]!.href,
                subtitle: links.filter((link) => !link.secondary).map((link) => link.label).join(', '),
                keywords: section.keywords, section: section.id,
                matchPaths: links.map((link) => link.href), mobilePrimary: section.mobilePrimary, mobileOrder: section.mobileOrder,
                children: links.length > 1 ? links.map(({ id, label, href }) => ({ id, label, href })) : undefined }];
        }
        return [{ id, ...meta, group: meta.navGroup, children: FEATURE_CHILDREN[id]?.length ? FEATURE_CHILDREN[id] : undefined }];
    });
    // Entities and Developer are maintenance pages: they live in the account
    // menu (desktop) and More (mobile), not in the main destination list.
    const settings: Destination[] = [];
    if (config.entitiesNavVisible) settings.push({ id: 'entities', ...ENTITIES_META, group: 'Tools' });
    if (config.developerNavVisible) settings.push({ id: 'developer', ...DEVELOPER_META, group: 'Tools' });
    const domains = ['Money', 'Life', 'Tools'] as const;
    const showHeadings = domains.filter((group) => destinations.filter((d) => d.group === group).length >= 2).length >= 2;
    const groups = showHeadings
        ? domains.map((label) => ({ label, links: destinations.filter((d) => d.group === label) })).filter((g) => g.links.length)
        : [{ label: '', links: destinations }];
    return { destinations: [...destinations, ...settings], sections: destinations, settings, groups, showHeadings };
}
