/**
 * Route patterns as modules declare them (`/finance/[year]/[month]`): each
 * `[param]` segment matches one path segment.
 */

export function patternRegex(pattern: string): RegExp {
    const source = pattern
        .split('/')
        .map((segment) => /^\[[^\]]+\]$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|\\]/g, '\\$&'))
        .join('/');
    return new RegExp(`^${source}/?$`);
}

export function matchesPattern(pattern: string, pathname: string): boolean {
    return patternRegex(pattern).test(pathname);
}
