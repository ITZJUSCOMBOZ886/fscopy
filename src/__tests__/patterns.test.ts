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

    test('escapes regex special characters in patterns', () => {
        // Dot should be literal, not "any character"
        expect(matchesExcludePattern('test.logs', ['test.logs'])).toBe(true);
        expect(matchesExcludePattern('testXlogs', ['test.logs'])).toBe(false);

        // With wildcard and dot
        expect(matchesExcludePattern('file.backup', ['*.backup'])).toBe(true);
        expect(matchesExcludePattern('fileXbackup', ['*.backup'])).toBe(false);

        // Other special chars: +, ?, ^, $, {}, (), [], |, \
        expect(matchesExcludePattern('data[0]', ['data[0]'])).toBe(true);
        expect(matchesExcludePattern('data0', ['data[0]'])).toBe(false);
        expect(matchesExcludePattern('foo(bar)', ['foo(bar)'])).toBe(true);
        expect(matchesExcludePattern('foobar', ['foo(bar)'])).toBe(false);
        expect(matchesExcludePattern('test+plus', ['test+plus'])).toBe(true);
        expect(matchesExcludePattern('testplus', ['test+plus'])).toBe(false);
        expect(matchesExcludePattern('maybe?', ['maybe?'])).toBe(true);
        expect(matchesExcludePattern('maybe', ['maybe?'])).toBe(false);
    });

    test('handles patterns with mixed special chars and wildcards', () => {
        expect(matchesExcludePattern('logs.2024.backup', ['logs.*.backup'])).toBe(true);
        expect(matchesExcludePattern('logsX2024Xbackup', ['logs.*.backup'])).toBe(false);
        expect(matchesExcludePattern('data[1].json', ['data[*].json'])).toBe(true);
        expect(matchesExcludePattern('data1Xjson', ['data[*].json'])).toBe(false);
    });
});
