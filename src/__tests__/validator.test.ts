import { describe, test, expect } from 'bun:test';
import { validateConfig } from '../config/validator.js';
import type { Config } from '../types.js';

// Helper to create a valid base config
function createConfig(overrides: Partial<Config> = {}): Config {
    return {
        collections: ['users'],
        includeSubcollections: false,
        dryRun: true,
        batchSize: 500,
        limit: 0,
        sourceProject: 'source-project',
        destProject: 'dest-project',
        retries: 3,
        where: [],
        exclude: [],
        merge: false,
        parallel: 1,
        clear: false,
        deleteMissing: false,
        transform: null,
        renameCollection: {},
        idPrefix: null,
        idSuffix: null,
        webhook: null,
        resume: false,
        stateFile: '.fscopy-state.json',
        verify: false,
        rateLimit: 0,
        skipOversized: false,
        json: false,
        ...overrides,
    };
}

describe('validateConfig', () => {
    test('returns no errors for valid config', () => {
        const config = createConfig();
        const errors = validateConfig(config);
        expect(errors).toEqual([]);
    });

    test('returns error for missing source project', () => {
        const config = createConfig({ sourceProject: null });
        const errors = validateConfig(config);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('Source project');
    });

    test('returns error for empty source project', () => {
        const config = createConfig({ sourceProject: '' });
        const errors = validateConfig(config);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('Source project');
    });

    test('returns error for missing dest project', () => {
        const config = createConfig({ destProject: null });
        const errors = validateConfig(config);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('Destination project');
    });

    test('returns error for empty dest project', () => {
        const config = createConfig({ destProject: '' });
        const errors = validateConfig(config);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('Destination project');
    });

    test('returns error for same source and dest without rename or id modification', () => {
        const config = createConfig({
            sourceProject: 'same-project',
            destProject: 'same-project',
        });
        const errors = validateConfig(config);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('same');
    });

    test('allows same source and dest with renameCollection', () => {
        const config = createConfig({
            sourceProject: 'same-project',
            destProject: 'same-project',
            renameCollection: { users: 'users_backup' },
        });
        const errors = validateConfig(config);
        expect(errors).toEqual([]);
    });

    test('allows same source and dest with idPrefix', () => {
        const config = createConfig({
            sourceProject: 'same-project',
            destProject: 'same-project',
            idPrefix: 'backup_',
        });
        const errors = validateConfig(config);
        expect(errors).toEqual([]);
    });

    test('allows same source and dest with idSuffix', () => {
        const config = createConfig({
            sourceProject: 'same-project',
            destProject: 'same-project',
            idSuffix: '_v2',
        });
        const errors = validateConfig(config);
        expect(errors).toEqual([]);
    });

    test('returns error for empty collections', () => {
        const config = createConfig({ collections: [] });
        const errors = validateConfig(config);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('collection');
    });

    test('returns multiple errors', () => {
        const config = createConfig({
            sourceProject: null,
            destProject: null,
            collections: [],
        });
        const errors = validateConfig(config);
        expect(errors).toHaveLength(3);
    });

    test('validates with multiple collections', () => {
        const config = createConfig({
            collections: ['users', 'orders', 'products'],
        });
        const errors = validateConfig(config);
        expect(errors).toEqual([]);
    });
});
