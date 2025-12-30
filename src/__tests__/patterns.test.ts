import { describe, test, expect } from 'bun:test';
import { matchesExcludePattern } from '../utils/patterns.js';

describe('matchesExcludePattern', () => {
    test('returns false for empty patterns', () => {
        expect(matchesExcludePattern('logs', [])).toBe(false);
    });

    test('matches exact pattern', () => {
        expect(matchesExcludePattern('logs', ['logs'])).toBe(true);
        expect(matchesExcludePattern('cache', ['logs'])).toBe(false);
    });

    test('matches path ending with pattern', () => {
        expect(matchesExcludePattern('users/123/logs', ['logs'])).toBe(true);
        expect(matchesExcludePattern('users/logs/data', ['logs'])).toBe(false);
    });

    test('matches glob pattern with single wildcard', () => {
        expect(matchesExcludePattern('temp_123', ['temp_*'])).toBe(true);
        expect(matchesExcludePattern('temp_abc_xyz', ['temp_*'])).toBe(true);
        expect(matchesExcludePattern('other_123', ['temp_*'])).toBe(false);
    });

    test('matches glob pattern with path', () => {
        expect(matchesExcludePattern('users/logs', ['users/*'])).toBe(true);
        expect(matchesExcludePattern('users/cache', ['users/*'])).toBe(true);
        expect(matchesExcludePattern('orders/logs', ['users/*'])).toBe(false);
    });

    test('matches multiple patterns', () => {
        const patterns = ['logs', 'cache', 'temp_*'];
        expect(matchesExcludePattern('logs', patterns)).toBe(true);
        expect(matchesExcludePattern('cache', patterns)).toBe(true);
        expect(matchesExcludePattern('temp_123', patterns)).toBe(true);
        expect(matchesExcludePattern('data', patterns)).toBe(false);
    });

    test('handles nested paths with wildcards', () => {
        expect(matchesExcludePattern('a/b/c', ['*/b/*'])).toBe(true);
        expect(matchesExcludePattern('x/y/z', ['*/b/*'])).toBe(false);
    });
});
