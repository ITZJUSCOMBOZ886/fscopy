import { describe, test, expect } from 'bun:test';
import ini from 'ini';

// =============================================================================
// Types
// =============================================================================

interface Config {
    collections: string[];
    includeSubcollections: boolean;
    dryRun: boolean;
    batchSize: number;
    limit: number;
    sourceProject: string | null;
    destProject: string | null;
    retries: number;
}

interface IniParsed {
    projects?: { source?: string; dest?: string };
    transfer?: {
        collections?: string;
        includeSubcollections?: string | boolean;
        dryRun?: string | boolean;
        batchSize?: string;
        limit?: string;
    };
}

interface JsonConfig {
    sourceProject?: string;
    destProject?: string;
    collections?: string[];
    includeSubcollections?: boolean;
    dryRun?: boolean;
    batchSize?: number;
    limit?: number;
}

// =============================================================================
// Functions to test (duplicated from cli.ts for isolated testing)
// =============================================================================

function parseBoolean(val: unknown): boolean {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
        return val.toLowerCase() === 'true';
    }
    return false;
}

function parseIniConfig(content: string): Partial<Config> {
    const parsed = ini.parse(content) as IniParsed;

    let collections: string[] = [];
    if (parsed.transfer?.collections) {
        collections = parsed.transfer.collections
            .split(',')
            .map((c) => c.trim())
            .filter((c) => c.length > 0);
    }

    return {
        sourceProject: parsed.projects?.source ?? null,
        destProject: parsed.projects?.dest ?? null,
        collections,
        includeSubcollections: parseBoolean(parsed.transfer?.includeSubcollections),
        dryRun: parseBoolean(parsed.transfer?.dryRun ?? 'true'),
        batchSize: Number.parseInt(parsed.transfer?.batchSize ?? '', 10) || 500,
        limit: Number.parseInt(parsed.transfer?.limit ?? '', 10) || 0,
    };
}

function parseJsonConfig(content: string): Partial<Config> {
    const config = JSON.parse(content) as JsonConfig;
    return {
        sourceProject: config.sourceProject ?? null,
        destProject: config.destProject ?? null,
        collections: config.collections,
        includeSubcollections: config.includeSubcollections,
        dryRun: config.dryRun,
        batchSize: config.batchSize,
        limit: config.limit,
    };
}

function validateConfig(config: Partial<Config>): string[] {
    const errors: string[] = [];

    if (!config.sourceProject) {
        errors.push('Source project is required (--source-project or in config file)');
    }
    if (!config.destProject) {
        errors.push('Destination project is required (--dest-project or in config file)');
    }
    if (config.sourceProject && config.destProject && config.sourceProject === config.destProject) {
        errors.push('Source and destination projects must be different');
    }
    if (!config.collections || config.collections.length === 0) {
        errors.push('At least one collection is required (-c or --collections)');
    }

    return errors;
}

function mergeConfig(
    defaults: Config,
    fileConfig: Partial<Config>,
    cliArgs: Partial<Config>
): Config {
    return {
        collections: cliArgs.collections ?? fileConfig.collections ?? defaults.collections,
        includeSubcollections:
            cliArgs.includeSubcollections ??
            fileConfig.includeSubcollections ??
            defaults.includeSubcollections,
        dryRun: cliArgs.dryRun ?? fileConfig.dryRun ?? defaults.dryRun,
        batchSize: cliArgs.batchSize ?? fileConfig.batchSize ?? defaults.batchSize,
        limit: cliArgs.limit ?? fileConfig.limit ?? defaults.limit,
        sourceProject: cliArgs.sourceProject ?? fileConfig.sourceProject ?? defaults.sourceProject,
        destProject: cliArgs.destProject ?? fileConfig.destProject ?? defaults.destProject,
        retries: cliArgs.retries ?? defaults.retries,
    };
}

// =============================================================================
// Tests
// =============================================================================

describe('parseBoolean', () => {
    test('returns true for boolean true', () => {
        expect(parseBoolean(true)).toBe(true);
    });

    test('returns false for boolean false', () => {
        expect(parseBoolean(false)).toBe(false);
    });

    test('returns true for string "true"', () => {
        expect(parseBoolean('true')).toBe(true);
    });

    test('returns true for string "TRUE"', () => {
        expect(parseBoolean('TRUE')).toBe(true);
    });

    test('returns false for string "false"', () => {
        expect(parseBoolean('false')).toBe(false);
    });

    test('returns false for other strings', () => {
        expect(parseBoolean('yes')).toBe(false);
        expect(parseBoolean('1')).toBe(false);
    });

    test('returns false for undefined', () => {
        expect(parseBoolean(undefined)).toBe(false);
    });
});

describe('parseIniConfig', () => {
    test('parses valid INI config', () => {
        const iniContent = `
[projects]
source = project-a
dest = project-b

[transfer]
collections = users, orders
includeSubcollections = true
dryRun = false
batchSize = 200
limit = 100
`;
        const config = parseIniConfig(iniContent);

        expect(config.sourceProject).toBe('project-a');
        expect(config.destProject).toBe('project-b');
        expect(config.collections).toEqual(['users', 'orders']);
        expect(config.includeSubcollections).toBe(true);
        expect(config.dryRun).toBe(false);
        expect(config.batchSize).toBe(200);
        expect(config.limit).toBe(100);
    });

    test('handles missing optional fields with defaults', () => {
        const iniContent = `
[projects]
source = project-a
dest = project-b

[transfer]
collections = users
`;
        const config = parseIniConfig(iniContent);

        expect(config.includeSubcollections).toBe(false);
        expect(config.dryRun).toBe(true);
        expect(config.batchSize).toBe(500);
        expect(config.limit).toBe(0);
    });

    test('handles empty collections', () => {
        const iniContent = `
[projects]
source = project-a
dest = project-b

[transfer]
collections =
`;
        const config = parseIniConfig(iniContent);
        expect(config.collections).toEqual([]);
    });

    test('trims whitespace from collections', () => {
        const iniContent = `
[projects]
source = project-a
dest = project-b

[transfer]
collections =   users  ,  orders  ,  products
`;
        const config = parseIniConfig(iniContent);
        expect(config.collections).toEqual(['users', 'orders', 'products']);
    });
});

describe('parseJsonConfig', () => {
    test('parses valid JSON config', () => {
        const jsonContent = JSON.stringify({
            sourceProject: 'project-a',
            destProject: 'project-b',
            collections: ['users', 'orders'],
            includeSubcollections: true,
            dryRun: false,
            batchSize: 200,
            limit: 100,
        });

        const config = parseJsonConfig(jsonContent);

        expect(config.sourceProject).toBe('project-a');
        expect(config.destProject).toBe('project-b');
        expect(config.collections).toEqual(['users', 'orders']);
        expect(config.includeSubcollections).toBe(true);
        expect(config.dryRun).toBe(false);
        expect(config.batchSize).toBe(200);
        expect(config.limit).toBe(100);
    });

    test('throws on invalid JSON', () => {
        expect(() => parseJsonConfig('{ invalid json }')).toThrow();
    });
});

describe('validateConfig', () => {
    test('returns no errors for valid config', () => {
        const config = {
            sourceProject: 'project-a',
            destProject: 'project-b',
            collections: ['users'],
        };
        expect(validateConfig(config)).toEqual([]);
    });

    test('returns error for missing source project', () => {
        const config = {
            destProject: 'project-b',
            collections: ['users'],
        };
        const errors = validateConfig(config);
        expect(errors.length).toBe(1);
        expect(errors[0]).toContain('Source project');
    });

    test('returns error for missing dest project', () => {
        const config = {
            sourceProject: 'project-a',
            collections: ['users'],
        };
        const errors = validateConfig(config);
        expect(errors.length).toBe(1);
        expect(errors[0]).toContain('Destination project');
    });

    test('returns error for same source and dest', () => {
        const config = {
            sourceProject: 'project-a',
            destProject: 'project-a',
            collections: ['users'],
        };
        const errors = validateConfig(config);
        expect(errors.length).toBe(1);
        expect(errors[0]).toContain('different');
    });

    test('returns error for empty collections', () => {
        const config = {
            sourceProject: 'project-a',
            destProject: 'project-b',
            collections: [],
        };
        const errors = validateConfig(config);
        expect(errors.length).toBe(1);
        expect(errors[0]).toContain('collection');
    });

    test('returns multiple errors', () => {
        const config = {
            collections: [],
        };
        const errors = validateConfig(config);
        expect(errors.length).toBe(3);
    });
});

describe('mergeConfig', () => {
    const defaults: Config = {
        collections: [],
        includeSubcollections: false,
        dryRun: true,
        batchSize: 500,
        limit: 0,
        sourceProject: null,
        destProject: null,
        retries: 3,
    };

    test('CLI args override file config', () => {
        const fileConfig: Partial<Config> = {
            sourceProject: 'file-project',
            collections: ['file-collection'],
        };
        const cliArgs: Partial<Config> = {
            sourceProject: 'cli-project',
        };

        const result = mergeConfig(defaults, fileConfig, cliArgs);

        expect(result.sourceProject).toBe('cli-project');
        expect(result.collections).toEqual(['file-collection']);
    });

    test('file config overrides defaults', () => {
        const fileConfig: Partial<Config> = {
            batchSize: 100,
        };
        const cliArgs: Partial<Config> = {};

        const result = mergeConfig(defaults, fileConfig, cliArgs);

        expect(result.batchSize).toBe(100);
        expect(result.dryRun).toBe(true); // from defaults
    });

    test('uses defaults when nothing provided', () => {
        const result = mergeConfig(defaults, {}, {});

        expect(result.batchSize).toBe(500);
        expect(result.dryRun).toBe(true);
        expect(result.retries).toBe(3);
    });
});
