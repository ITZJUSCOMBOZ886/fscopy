export function matchesExcludePattern(path: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
        if (pattern.includes('*')) {
            // Convert glob pattern to regex
            const regex = new RegExp('^' + pattern.replaceAll('*', '.*') + '$');
            if (regex.test(path)) return true;
        } else if (path === pattern || path.endsWith('/' + pattern)) {
            // Exact match or ends with pattern
            return true;
        }
    }
    return false;
}
