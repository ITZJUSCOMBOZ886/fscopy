export function matchesExcludePattern(path: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
        if (pattern.includes('*')) {
            // Convert glob pattern to regex (escape special chars first, then convert * to .*)
            const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`);
            const regex = new RegExp('^' + escaped.replaceAll('*', '.*') + '$');
            if (regex.test(path)) return true;
        } else if (path === pattern || path.endsWith('/' + pattern)) {
            // Exact match or ends with pattern
            return true;
        }
    }
    return false;
}
