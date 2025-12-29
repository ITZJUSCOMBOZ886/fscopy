#!/usr/bin/env bun

import admin from 'firebase-admin';
import type { Firestore, DocumentReference, WriteBatch } from 'firebase-admin/firestore';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import ini from 'ini';
import cliProgress from 'cli-progress';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { input, confirm, checkbox } from '@inquirer/prompts';

// =============================================================================
// Types
// =============================================================================

interface WhereFilter {
    field: string;
    operator: FirebaseFirestore.WhereFilterOp;
    value: string | number | boolean;
}

interface Config {
    collections: string[];
    includeSubcollections: boolean;
    dryRun: boolean;
    batchSize: number;
    limit: number;
    sourceProject: string | null;
    destProject: string | null;
    retries: number;
    where: WhereFilter[];
    exclude: string[];
    merge: boolean;
    parallel: number;
    clear: boolean;
    deleteMissing: boolean;
    transform: string | null;
    renameCollection: Record<string, string>;
    idPrefix: string | null;
    idSuffix: string | null;
}

type TransformFunction = (
    doc: Record<string, unknown>,
    meta: { id: string; path: string }
) => Record<string, unknown> | null;

interface Stats {
    collectionsProcessed: number;
    documentsTransferred: number;
    documentsDeleted: number;
    errors: number;
}

interface LogEntry {
    timestamp: string;
    level: string;
    message: string;
    [key: string]: unknown;
}

interface RetryOptions {
    retries?: number;
    baseDelay?: number;
    maxDelay?: number;
    onRetry?: (attempt: number, max: number, error: Error, delay: number) => void;
}

interface CliArgs {
    init?: string;
    config?: string;
    collections?: string[];
    includeSubcollections?: boolean;
    dryRun?: boolean;
    batchSize?: number;
    limit?: number;
    sourceProject?: string;
    destProject?: string;
    yes: boolean;
    log?: string;
    retries: number;
    quiet: boolean;
    where?: string[];
    exclude?: string[];
    merge?: boolean;
    parallel?: number;
    clear?: boolean;
    deleteMissing?: boolean;
    interactive?: boolean;
    transform?: string;
    renameCollection?: string[];
    idPrefix?: string;
    idSuffix?: string;
}

// =============================================================================
// CLI Arguments
// =============================================================================

const argv = yargs(hideBin(process.argv))
    .scriptName('fscopy')
    .usage('$0 [options]')
    .option('init', {
        type: 'string',
        description: 'Generate a config template file (.ini by default, .json if specified)',
        nargs: 1,
        default: undefined,
    })
    .option('config', {
        alias: 'f',
        type: 'string',
        description: 'Path to config file (.ini or .json)',
    })
    .option('collections', {
        alias: 'c',
        type: 'array',
        description: 'Collections to transfer (e.g., -c users orders)',
    })
    .option('include-subcollections', {
        alias: 's',
        type: 'boolean',
        description: 'Include subcollections in transfer',
    })
    .option('dry-run', {
        alias: 'd',
        type: 'boolean',
        description: 'Preview transfer without writing',
    })
    .option('batch-size', {
        alias: 'b',
        type: 'number',
        description: 'Number of documents per batch write',
    })
    .option('limit', {
        alias: 'l',
        type: 'number',
        description: 'Limit number of documents per collection (0 = no limit)',
    })
    .option('source-project', {
        type: 'string',
        description: 'Source Firebase project ID',
    })
    .option('dest-project', {
        type: 'string',
        description: 'Destination Firebase project ID',
    })
    .option('yes', {
        alias: 'y',
        type: 'boolean',
        description: 'Skip confirmation prompt',
        default: false,
    })
    .option('log', {
        type: 'string',
        description: 'Path to log file for transfer details',
    })
    .option('retries', {
        type: 'number',
        description: 'Number of retries on error (default: 3)',
        default: 3,
    })
    .option('quiet', {
        alias: 'q',
        type: 'boolean',
        description: 'Minimal output (no progress bar)',
        default: false,
    })
    .option('where', {
        alias: 'w',
        type: 'array',
        description: 'Filter documents (e.g., --where "status == active")',
    })
    .option('exclude', {
        alias: 'x',
        type: 'array',
        description: 'Exclude subcollections by pattern (e.g., --exclude "logs" "temp/*")',
    })
    .option('merge', {
        alias: 'm',
        type: 'boolean',
        description: 'Merge documents instead of overwriting',
        default: false,
    })
    .option('parallel', {
        alias: 'p',
        type: 'number',
        description: 'Number of parallel collection transfers (default: 1)',
        default: 1,
    })
    .option('clear', {
        type: 'boolean',
        description: 'Clear destination collections before transfer (DESTRUCTIVE)',
        default: false,
    })
    .option('delete-missing', {
        type: 'boolean',
        description: 'Delete destination docs not present in source (sync mode)',
        default: false,
    })
    .option('interactive', {
        alias: 'i',
        type: 'boolean',
        description: 'Interactive mode with prompts for project and collection selection',
        default: false,
    })
    .option('transform', {
        alias: 't',
        type: 'string',
        description: 'Path to JS/TS file exporting a transform(doc, meta) function',
    })
    .option('rename-collection', {
        alias: 'r',
        type: 'array',
        description: 'Rename collection in destination (format: source:dest)',
    })
    .option('id-prefix', {
        type: 'string',
        description: 'Add prefix to document IDs in destination',
    })
    .option('id-suffix', {
        type: 'string',
        description: 'Add suffix to document IDs in destination',
    })
    .example('$0 --init config.ini', 'Generate INI config template (default)')
    .example('$0 --init config.json', 'Generate JSON config template')
    .example('$0 -f config.ini', 'Run transfer with config file')
    .example('$0 -f config.ini -d false -y', 'Live transfer, skip confirmation')
    .example('$0 -f config.ini --log transfer.log', 'Transfer with logging')
    .example('$0 -f config.ini --where "active == true"', 'Filter documents')
    .example('$0 -f config.ini --exclude "logs" --exclude "cache"', 'Exclude subcollections')
    .example('$0 -f config.ini --merge', 'Merge instead of overwrite')
    .example('$0 -f config.ini --parallel 3', 'Transfer 3 collections in parallel')
    .example('$0 -f config.ini --clear', 'Clear destination before transfer')
    .example('$0 -f config.ini --delete-missing', 'Sync mode: delete orphan docs in dest')
    .example('$0 -i', 'Interactive mode with prompts')
    .example('$0 -f config.ini -t ./transform.ts', 'Transform documents during transfer')
    .example('$0 -f config.ini -r users:users_backup', 'Rename collection in destination')
    .example('$0 -f config.ini --id-prefix backup_', 'Add prefix to document IDs')
    .help()
    .parseSync() as CliArgs;

// =============================================================================
// Constants & Templates
// =============================================================================

const defaults: Config = {
    collections: [],
    includeSubcollections: false,
    dryRun: true,
    batchSize: 500,
    limit: 0,
    sourceProject: null,
    destProject: null,
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
};

const iniTemplate = `; fscopy configuration file

[projects]
source = my-source-project
dest = my-dest-project

[transfer]
; Comma-separated list of collections
collections = collection1, collection2
includeSubcollections = false
dryRun = true
batchSize = 500
limit = 0

[options]
; Filter documents: "field operator value" (operators: ==, !=, <, >, <=, >=)
; where = status == active
; Exclude subcollections by pattern (comma-separated, supports glob)
; exclude = logs, temp/*, cache
; Merge documents instead of overwriting
merge = false
; Number of parallel collection transfers
parallel = 1
; Clear destination collections before transfer (DESTRUCTIVE)
clear = false
; Delete destination docs not present in source (sync mode)
deleteMissing = false
; Transform documents during transfer (path to JS/TS file)
; transform = ./transforms/anonymize.ts
; Rename collections in destination (format: source:dest, comma-separated)
; renameCollection = users:users_backup, orders:orders_2024
; Add prefix or suffix to document IDs
; idPrefix = backup_
; idSuffix = _v2
`;

const jsonTemplate = {
    sourceProject: 'my-source-project',
    destProject: 'my-dest-project',
    collections: ['collection1', 'collection2'],
    includeSubcollections: false,
    dryRun: true,
    batchSize: 500,
    limit: 0,
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
};

// =============================================================================
// Logger
// =============================================================================

class Logger {
    private readonly logPath: string | undefined;
    private readonly entries: LogEntry[] = [];
    private readonly startTime: Date;

    constructor(logPath?: string) {
        this.logPath = logPath;
        this.startTime = new Date();
    }

    log(level: string, message: string, data: Record<string, unknown> = {}): void {
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            ...data,
        };
        this.entries.push(entry);

        if (this.logPath) {
            const line =
                `[${entry.timestamp}] [${level}] ${message}` +
                (Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '') +
                '\n';
            fs.appendFileSync(this.logPath, line);
        }
    }

    info(message: string, data?: Record<string, unknown>): void {
        this.log('INFO', message, data);
    }

    error(message: string, data?: Record<string, unknown>): void {
        this.log('ERROR', message, data);
    }

    success(message: string, data?: Record<string, unknown>): void {
        this.log('SUCCESS', message, data);
    }

    init(): void {
        if (this.logPath) {
            const header = `# fscopy transfer log\n# Started: ${this.startTime.toISOString()}\n\n`;
            fs.writeFileSync(this.logPath, header);
        }
    }

    summary(stats: Stats, duration: string): void {
        if (this.logPath) {
            let summary = `\n# Summary\n# Collections: ${stats.collectionsProcessed}\n`;
            if (stats.documentsDeleted > 0) {
                summary += `# Deleted: ${stats.documentsDeleted}\n`;
            }
            summary += `# Transferred: ${stats.documentsTransferred}\n# Errors: ${stats.errors}\n# Duration: ${duration}s\n`;
            fs.appendFileSync(this.logPath, summary);
        }
    }
}

// =============================================================================
// Retry Logic
// =============================================================================

async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
    const { retries = 3, baseDelay = 1000, maxDelay = 30000, onRetry } = options;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error as Error;

            if (attempt < retries) {
                const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
                if (onRetry) {
                    onRetry(attempt + 1, retries, lastError, delay);
                }
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
}

// =============================================================================
// Config Parsing
// =============================================================================

function getFileFormat(filePath: string): 'json' | 'ini' {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') return 'json';
    return 'ini';
}

function parseBoolean(val: unknown): boolean {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
        return val.toLowerCase() === 'true';
    }
    return false;
}

function parseWhereFilter(filterStr: string): WhereFilter | null {
    // Parse "field operator value" format
    const operatorRegex = /(==|!=|<=|>=|<|>)/;
    const match = new RegExp(operatorRegex).exec(filterStr);

    if (!match) {
        console.warn(`⚠️  Invalid where filter: "${filterStr}" (missing operator)`);
        return null;
    }

    const operator = match[0] as FirebaseFirestore.WhereFilterOp;
    const [fieldPart, valuePart] = filterStr.split(operatorRegex).filter((_, i) => i !== 1);

    if (!fieldPart || !valuePart) {
        console.warn(`⚠️  Invalid where filter: "${filterStr}" (missing field or value)`);
        return null;
    }

    const field = fieldPart.trim();
    const rawValue = valuePart.trim();

    // Parse value type
    let value: string | number | boolean;
    if (rawValue === 'true') {
        value = true;
    } else if (rawValue === 'false') {
        value = false;
    } else if (rawValue === 'null') {
        value = null as unknown as string; // Firestore supports null
    } else if (!Number.isNaN(Number(rawValue)) && rawValue !== '') {
        value = Number(rawValue);
    } else {
        // Remove quotes if present
        value = rawValue.replaceAll(/(?:^["'])|(?:["']$)/g, '');
    }

    return { field, operator, value };
}

function parseWhereFilters(filters: string[] | undefined): WhereFilter[] {
    if (!filters || filters.length === 0) return [];
    return filters.map(parseWhereFilter).filter((f): f is WhereFilter => f !== null);
}

function parseStringList(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

function parseRenameMapping(mappings: string[] | string | undefined): Record<string, string> {
    if (!mappings) return {};

    const result: Record<string, string> = {};
    const items = Array.isArray(mappings) ? mappings : parseStringList(mappings);

    for (const item of items) {
        const mapping = String(item).trim();
        const colonIndex = mapping.indexOf(':');
        if (colonIndex === -1) {
            console.warn(`⚠️  Invalid rename mapping: "${mapping}" (missing ':')`);
            continue;
        }
        const source = mapping.slice(0, colonIndex).trim();
        const dest = mapping.slice(colonIndex + 1).trim();
        if (!source || !dest) {
            console.warn(`⚠️  Invalid rename mapping: "${mapping}" (empty source or dest)`);
            continue;
        }
        result[source] = dest;
    }

    return result;
}

function matchesExcludePattern(path: string, patterns: string[]): boolean {
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

function parseIniConfig(content: string): Partial<Config> {
    const parsed = ini.parse(content) as {
        projects?: { source?: string; dest?: string };
        transfer?: {
            collections?: string;
            includeSubcollections?: string | boolean;
            dryRun?: string | boolean;
            batchSize?: string;
            limit?: string;
        };
        options?: {
            where?: string;
            exclude?: string;
            merge?: string | boolean;
            parallel?: string;
            clear?: string | boolean;
            deleteMissing?: string | boolean;
            transform?: string;
            renameCollection?: string;
            idPrefix?: string;
            idSuffix?: string;
        };
    };

    let collections: string[] = [];
    if (parsed.transfer?.collections) {
        collections = parsed.transfer.collections
            .split(',')
            .map((c) => c.trim())
            .filter((c) => c.length > 0);
    }

    // Parse where filters from INI (single filter per line or comma-separated)
    const whereFilters = parsed.options?.where
        ? parseWhereFilters(parseStringList(parsed.options.where))
        : [];

    return {
        sourceProject: parsed.projects?.source ?? null,
        destProject: parsed.projects?.dest ?? null,
        collections,
        includeSubcollections: parseBoolean(parsed.transfer?.includeSubcollections),
        dryRun: parseBoolean(parsed.transfer?.dryRun ?? 'true'),
        batchSize: Number.parseInt(parsed.transfer?.batchSize ?? '', 10) || 500,
        limit: Number.parseInt(parsed.transfer?.limit ?? '', 10) || 0,
        where: whereFilters,
        exclude: parseStringList(parsed.options?.exclude),
        merge: parseBoolean(parsed.options?.merge),
        parallel: Number.parseInt(parsed.options?.parallel ?? '', 10) || 1,
        clear: parseBoolean(parsed.options?.clear),
        deleteMissing: parseBoolean(parsed.options?.deleteMissing),
        transform: parsed.options?.transform ?? null,
        renameCollection: parseRenameMapping(parsed.options?.renameCollection),
        idPrefix: parsed.options?.idPrefix ?? null,
        idSuffix: parsed.options?.idSuffix ?? null,
    };
}

function parseJsonConfig(content: string): Partial<Config> {
    const config = JSON.parse(content) as {
        sourceProject?: string;
        destProject?: string;
        collections?: string[];
        includeSubcollections?: boolean;
        dryRun?: boolean;
        batchSize?: number;
        limit?: number;
        where?: string[];
        exclude?: string[];
        merge?: boolean;
        parallel?: number;
        clear?: boolean;
        deleteMissing?: boolean;
        transform?: string;
        renameCollection?: Record<string, string>;
        idPrefix?: string;
        idSuffix?: string;
    };

    return {
        sourceProject: config.sourceProject ?? null,
        destProject: config.destProject ?? null,
        collections: config.collections,
        includeSubcollections: config.includeSubcollections,
        dryRun: config.dryRun,
        batchSize: config.batchSize,
        limit: config.limit,
        where: parseWhereFilters(config.where),
        exclude: config.exclude,
        merge: config.merge,
        parallel: config.parallel,
        clear: config.clear,
        deleteMissing: config.deleteMissing,
        transform: config.transform ?? null,
        renameCollection: config.renameCollection ?? {},
        idPrefix: config.idPrefix ?? null,
        idSuffix: config.idSuffix ?? null,
    };
}

function loadConfigFile(configPath?: string): Partial<Config> {
    if (!configPath) return {};

    const absolutePath = path.resolve(configPath);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`Config file not found: ${absolutePath}`);
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');
    const format = getFileFormat(absolutePath);

    console.log(`📄 Loaded config from: ${absolutePath} (${format.toUpperCase()})\n`);

    return format === 'json' ? parseJsonConfig(content) : parseIniConfig(content);
}

function mergeConfig(defaultConfig: Config, fileConfig: Partial<Config>, cliArgs: CliArgs): Config {
    // Parse CLI where filters
    const cliWhereFilters = parseWhereFilters(cliArgs.where);

    // Parse CLI rename collection mappings
    const cliRenameCollection = parseRenameMapping(cliArgs.renameCollection);

    return {
        collections: cliArgs.collections ?? fileConfig.collections ?? defaultConfig.collections,
        includeSubcollections:
            cliArgs.includeSubcollections ??
            fileConfig.includeSubcollections ??
            defaultConfig.includeSubcollections,
        dryRun: cliArgs.dryRun ?? fileConfig.dryRun ?? defaultConfig.dryRun,
        batchSize: cliArgs.batchSize ?? fileConfig.batchSize ?? defaultConfig.batchSize,
        limit: cliArgs.limit ?? fileConfig.limit ?? defaultConfig.limit,
        sourceProject:
            cliArgs.sourceProject ?? fileConfig.sourceProject ?? defaultConfig.sourceProject,
        destProject: cliArgs.destProject ?? fileConfig.destProject ?? defaultConfig.destProject,
        retries: cliArgs.retries ?? defaultConfig.retries,
        where:
            cliWhereFilters.length > 0
                ? cliWhereFilters
                : (fileConfig.where ?? defaultConfig.where),
        exclude: cliArgs.exclude ?? fileConfig.exclude ?? defaultConfig.exclude,
        merge: cliArgs.merge ?? fileConfig.merge ?? defaultConfig.merge,
        parallel: cliArgs.parallel ?? fileConfig.parallel ?? defaultConfig.parallel,
        clear: cliArgs.clear ?? fileConfig.clear ?? defaultConfig.clear,
        deleteMissing: cliArgs.deleteMissing ?? fileConfig.deleteMissing ?? defaultConfig.deleteMissing,
        transform: cliArgs.transform ?? fileConfig.transform ?? defaultConfig.transform,
        renameCollection:
            Object.keys(cliRenameCollection).length > 0
                ? cliRenameCollection
                : (fileConfig.renameCollection ?? defaultConfig.renameCollection),
        idPrefix: cliArgs.idPrefix ?? fileConfig.idPrefix ?? defaultConfig.idPrefix,
        idSuffix: cliArgs.idSuffix ?? fileConfig.idSuffix ?? defaultConfig.idSuffix,
    };
}

function validateConfig(config: Config): string[] {
    const errors: string[] = [];

    if (!config.sourceProject) {
        errors.push('Source project is required (--source-project or in config file)');
    }
    if (!config.destProject) {
        errors.push('Destination project is required (--dest-project or in config file)');
    }
    if (config.sourceProject && config.destProject && config.sourceProject === config.destProject) {
        // Same project is allowed only if we're renaming collections or modifying IDs
        const hasRenamedCollections = Object.keys(config.renameCollection).length > 0;
        const hasIdModification = config.idPrefix !== null || config.idSuffix !== null;

        if (!hasRenamedCollections && !hasIdModification) {
            errors.push(
                'Source and destination projects are the same. ' +
                'Use --rename-collection or --id-prefix/--id-suffix to avoid overwriting data.'
            );
        }
    }
    if (!config.collections || config.collections.length === 0) {
        errors.push('At least one collection is required (-c or --collections)');
    }

    return errors;
}

// =============================================================================
// Config File Generation
// =============================================================================

function generateConfigFile(outputPath: string): boolean {
    const filePath = path.resolve(outputPath);
    const format = getFileFormat(filePath);

    if (fs.existsSync(filePath)) {
        console.error(`❌ File already exists: ${filePath}`);
        console.error('   Use a different filename or delete the existing file.');
        process.exitCode = 1;
        return false;
    }

    const content = format === 'json' ? JSON.stringify(jsonTemplate, null, 4) : iniTemplate;

    fs.writeFileSync(filePath, content, 'utf-8');

    console.log(`✓ Config template created: ${filePath}`);
    console.log('');
    console.log('Edit the file to configure your transfer, then run:');
    console.log(`  fscopy -f ${outputPath}`);

    return true;
}

// =============================================================================
// Transform Loading
// =============================================================================

async function loadTransformFunction(transformPath: string): Promise<TransformFunction> {
    const absolutePath = path.resolve(transformPath);

    if (!fs.existsSync(absolutePath)) {
        throw new Error(`Transform file not found: ${absolutePath}`);
    }

    try {
        const module = await import(absolutePath);

        // Look for 'transform' export (default or named)
        const transformFn = module.default?.transform ?? module.transform ?? module.default;

        if (typeof transformFn !== 'function') {
            throw new Error(
                `Transform file must export a 'transform' function. Got: ${typeof transformFn}`
            );
        }

        return transformFn as TransformFunction;
    } catch (error) {
        if ((error as Error).message.includes('Transform file')) {
            throw error;
        }
        throw new Error(`Failed to load transform file: ${(error as Error).message}`);
    }
}

// =============================================================================
// Display & Confirmation
// =============================================================================

function displayConfig(config: Config): void {
    console.log('='.repeat(60));
    console.log('🔄 FSCOPY - CONFIGURATION');
    console.log('='.repeat(60));
    console.log('');
    console.log(`  📤 Source project:       ${config.sourceProject || '(not set)'}`);
    console.log(`  📥 Destination project:  ${config.destProject || '(not set)'}`);
    console.log('');
    console.log(
        `  📋 Collections:          ${config.collections.length > 0 ? config.collections.join(', ') : '(none)'}`
    );
    console.log(`  📂 Include subcollections: ${config.includeSubcollections}`);
    console.log(`  🔢 Document limit:       ${config.limit === 0 ? 'No limit' : config.limit}`);
    console.log(`  📦 Batch size:           ${config.batchSize}`);
    console.log(`  🔄 Retries on error:     ${config.retries}`);

    // New options
    if (config.where.length > 0) {
        const whereStr = config.where.map((w) => `${w.field} ${w.operator} ${w.value}`).join(', ');
        console.log(`  🔍 Where filters:        ${whereStr}`);
    }
    if (config.exclude.length > 0) {
        console.log(`  🚫 Exclude patterns:     ${config.exclude.join(', ')}`);
    }
    if (config.merge) {
        console.log(`  🔀 Merge mode:           enabled (merge instead of overwrite)`);
    }
    if (config.parallel > 1) {
        console.log(`  ⚡ Parallel transfers:   ${config.parallel} collections`);
    }
    if (config.clear) {
        console.log(`  🗑️  Clear destination:    enabled (DESTRUCTIVE)`);
    }
    if (config.deleteMissing) {
        console.log(`  🔄 Delete missing:       enabled (sync mode)`);
    }
    if (config.transform) {
        console.log(`  🔧 Transform:            ${config.transform}`);
    }
    if (Object.keys(config.renameCollection).length > 0) {
        const renameStr = Object.entries(config.renameCollection)
            .map(([src, dest]) => `${src}→${dest}`)
            .join(', ');
        console.log(`  📝 Rename collections:   ${renameStr}`);
    }
    if (config.idPrefix || config.idSuffix) {
        const idMod = [
            config.idPrefix ? `prefix: "${config.idPrefix}"` : null,
            config.idSuffix ? `suffix: "${config.idSuffix}"` : null,
        ]
            .filter(Boolean)
            .join(', ');
        console.log(`  🏷️  ID modification:      ${idMod}`);
    }

    console.log('');

    if (config.dryRun) {
        console.log('  🔍 Mode:                 DRY RUN (no data will be written)');
    } else {
        console.log('  ⚡ Mode:                 LIVE (data WILL be transferred)');
    }

    console.log('');
    console.log('='.repeat(60));
}

async function askConfirmation(config: Config): Promise<boolean> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        const modeText = config.dryRun ? 'DRY RUN' : '⚠️  LIVE TRANSFER';
        rl.question(`\nProceed with ${modeText}? (y/N): `, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
        });
    });
}

// =============================================================================
// Interactive Mode
// =============================================================================

async function runInteractiveMode(config: Config): Promise<Config> {
    console.log('\n' + '='.repeat(60));
    console.log('🔄 FSCOPY - INTERACTIVE MODE');
    console.log('='.repeat(60) + '\n');

    // Prompt for source project if not set
    let sourceProject = config.sourceProject;
    if (!sourceProject) {
        sourceProject = await input({
            message: 'Source Firebase project ID:',
            validate: (value) => value.length > 0 || 'Project ID is required',
        });
    } else {
        console.log(`📤 Source project: ${sourceProject}`);
    }

    // Prompt for destination project if not set
    let destProject = config.destProject;
    if (!destProject) {
        destProject = await input({
            message: 'Destination Firebase project ID:',
            validate: (value) => {
                if (value.length === 0) return 'Project ID is required';
                if (value === sourceProject) return 'Must be different from source';
                return true;
            },
        });
    } else {
        console.log(`📥 Destination project: ${destProject}`);
    }

    // Initialize source Firebase to list collections
    console.log('\n📊 Connecting to source project...');
    const tempSourceApp = admin.initializeApp(
        {
            credential: admin.credential.applicationDefault(),
            projectId: sourceProject,
        },
        'interactive-source'
    );
    const sourceDb = tempSourceApp.firestore();

    // List all root collections
    const rootCollections = await sourceDb.listCollections();
    const collectionIds = rootCollections.map((col) => col.id);

    if (collectionIds.length === 0) {
        console.log('\n⚠️  No collections found in source project');
        await tempSourceApp.delete();
        process.exit(0);
    }

    // Count documents in each collection for preview
    console.log('\n📋 Available collections:');
    const collectionInfo: { id: string; count: number }[] = [];
    for (const id of collectionIds) {
        const snapshot = await sourceDb.collection(id).count().get();
        const count = snapshot.data().count;
        collectionInfo.push({ id, count });
        console.log(`   - ${id} (${count} documents)`);
    }

    // Let user select collections
    console.log('');
    const selectedCollections = await checkbox({
        message: 'Select collections to transfer:',
        choices: collectionInfo.map((col) => ({
            name: `${col.id} (${col.count} docs)`,
            value: col.id,
            checked: config.collections.includes(col.id),
        })),
        validate: (value) => value.length > 0 || 'Select at least one collection',
    });

    // Ask about options
    console.log('');
    const includeSubcollections = await confirm({
        message: 'Include subcollections?',
        default: config.includeSubcollections,
    });

    const dryRun = await confirm({
        message: 'Dry run mode (preview without writing)?',
        default: config.dryRun,
    });

    const merge = await confirm({
        message: 'Merge mode (update instead of overwrite)?',
        default: config.merge,
    });

    // Clean up temporary app
    await tempSourceApp.delete();

    // Return updated config
    return {
        ...config,
        sourceProject,
        destProject,
        collections: selectedCollections,
        includeSubcollections,
        dryRun,
        merge,
    };
}

// =============================================================================
// Firebase
// =============================================================================

let sourceApp: admin.app.App | null = null;
let destApp: admin.app.App | null = null;

function initializeFirebase(config: Config): { sourceDb: Firestore; destDb: Firestore } {
    sourceApp = admin.initializeApp(
        {
            credential: admin.credential.applicationDefault(),
            projectId: config.sourceProject!,
        },
        'source'
    );

    destApp = admin.initializeApp(
        {
            credential: admin.credential.applicationDefault(),
            projectId: config.destProject!,
        },
        'dest'
    );

    return {
        sourceDb: sourceApp.firestore(),
        destDb: destApp.firestore(),
    };
}

async function cleanupFirebase(): Promise<void> {
    if (sourceApp) await sourceApp.delete();
    if (destApp) await destApp.delete();
}

async function getSubcollections(docRef: DocumentReference): Promise<string[]> {
    const collections = await docRef.listCollections();
    return collections.map((col) => col.id);
}

function getDestCollectionPath(
    sourcePath: string,
    renameMapping: Record<string, string>
): string {
    // Get the root collection name from the source path
    const rootCollection = sourcePath.split('/')[0];

    // Check if this root collection should be renamed
    if (renameMapping[rootCollection]) {
        // Replace the root collection name with the destination name
        return renameMapping[rootCollection] + sourcePath.slice(rootCollection.length);
    }

    return sourcePath;
}

function getDestDocId(
    sourceId: string,
    prefix: string | null,
    suffix: string | null
): string {
    let destId = sourceId;
    if (prefix) {
        destId = prefix + destId;
    }
    if (suffix) {
        destId = destId + suffix;
    }
    return destId;
}

// =============================================================================
// Transfer Logic
// =============================================================================

async function clearCollection(
    db: Firestore,
    collectionPath: string,
    config: Config,
    logger: Logger,
    includeSubcollections: boolean
): Promise<number> {
    let deletedCount = 0;
    const collectionRef = db.collection(collectionPath);
    const snapshot = await collectionRef.get();

    if (snapshot.empty) {
        return 0;
    }

    // Delete subcollections first if enabled
    if (includeSubcollections) {
        for (const doc of snapshot.docs) {
            const subcollections = await getSubcollections(doc.ref);
            for (const subId of subcollections) {
                // Check exclude patterns
                if (matchesExcludePattern(subId, config.exclude)) {
                    continue;
                }
                const subPath = `${collectionPath}/${doc.id}/${subId}`;
                deletedCount += await clearCollection(db, subPath, config, logger, true);
            }
        }
    }

    // Delete documents in batches
    const docs = snapshot.docs;
    for (let i = 0; i < docs.length; i += config.batchSize) {
        const batch = docs.slice(i, i + config.batchSize);
        const writeBatch = db.batch();

        for (const doc of batch) {
            writeBatch.delete(doc.ref);
            deletedCount++;
        }

        if (!config.dryRun) {
            await withRetry(() => writeBatch.commit(), {
                retries: config.retries,
                onRetry: (attempt, max, err, delay) => {
                    logger.error(`Retry delete ${attempt}/${max} for ${collectionPath}`, {
                        error: err.message,
                        delay,
                    });
                },
            });
        }

        logger.info(`Deleted ${batch.length} documents from ${collectionPath}`);
    }

    return deletedCount;
}

async function deleteOrphanDocuments(
    sourceDb: Firestore,
    destDb: Firestore,
    sourceCollectionPath: string,
    config: Config,
    logger: Logger
): Promise<number> {
    let deletedCount = 0;

    // Get the destination path (may be renamed)
    const destCollectionPath = getDestCollectionPath(sourceCollectionPath, config.renameCollection);

    // Get all document IDs from source
    const sourceSnapshot = await sourceDb.collection(sourceCollectionPath).get();
    const sourceIds = new Set(sourceSnapshot.docs.map((doc) => doc.id));

    // Get all document IDs from destination
    const destSnapshot = await destDb.collection(destCollectionPath).get();

    // Find orphan documents (in dest but not in source)
    const orphanDocs = destSnapshot.docs.filter((doc) => !sourceIds.has(doc.id));

    if (orphanDocs.length === 0) {
        return 0;
    }

    logger.info(`Found ${orphanDocs.length} orphan documents in ${destCollectionPath}`);

    // Delete orphan documents in batches
    for (let i = 0; i < orphanDocs.length; i += config.batchSize) {
        const batch = orphanDocs.slice(i, i + config.batchSize);
        const writeBatch = destDb.batch();

        for (const doc of batch) {
            // If subcollections are included, recursively delete orphans in subcollections first
            if (config.includeSubcollections) {
                const subcollections = await getSubcollections(doc.ref);
                for (const subId of subcollections) {
                    if (matchesExcludePattern(subId, config.exclude)) {
                        continue;
                    }
                    const subPath = `${destCollectionPath}/${doc.id}/${subId}`;
                    // For orphan parent docs, clear all subcollection data
                    deletedCount += await clearCollection(destDb, subPath, config, logger, true);
                }
            }

            writeBatch.delete(doc.ref);
            deletedCount++;
        }

        if (!config.dryRun) {
            await withRetry(() => writeBatch.commit(), {
                retries: config.retries,
                onRetry: (attempt, max, err, delay) => {
                    logger.error(`Retry delete orphans ${attempt}/${max} for ${destCollectionPath}`, {
                        error: err.message,
                        delay,
                    });
                },
            });
        }

        logger.info(`Deleted ${batch.length} orphan documents from ${destCollectionPath}`);
    }

    // Also check subcollections of existing documents for orphans
    if (config.includeSubcollections) {
        for (const sourceDoc of sourceSnapshot.docs) {
            const sourceSubcollections = await getSubcollections(sourceDoc.ref);
            for (const subId of sourceSubcollections) {
                if (matchesExcludePattern(subId, config.exclude)) {
                    continue;
                }
                const subPath = `${sourceCollectionPath}/${sourceDoc.id}/${subId}`;
                deletedCount += await deleteOrphanDocuments(sourceDb, destDb, subPath, config, logger);
            }
        }
    }

    return deletedCount;
}

async function countDocuments(
    sourceDb: Firestore,
    collectionPath: string,
    config: Config,
    depth: number = 0
): Promise<number> {
    let count = 0;

    // Build query with where filters (only at root level)
    let query: FirebaseFirestore.Query = sourceDb.collection(collectionPath);
    if (depth === 0 && config.where.length > 0) {
        for (const filter of config.where) {
            query = query.where(filter.field, filter.operator, filter.value);
        }
    }

    const snapshot = await query.get();
    count += snapshot.size;

    if (config.includeSubcollections) {
        for (const doc of snapshot.docs) {
            const subcollections = await getSubcollections(doc.ref);
            for (const subId of subcollections) {
                const subPath = `${collectionPath}/${doc.id}/${subId}`;

                // Check exclude patterns
                if (matchesExcludePattern(subId, config.exclude)) {
                    continue;
                }

                count += await countDocuments(sourceDb, subPath, config, depth + 1);
            }
        }
    }

    return count;
}

interface TransferContext {
    sourceDb: Firestore;
    destDb: Firestore;
    config: Config;
    stats: Stats;
    logger: Logger;
    progressBar: cliProgress.SingleBar | null;
    transformFn: TransformFunction | null;
}

async function transferCollection(
    ctx: TransferContext,
    collectionPath: string,
    depth: number = 0
): Promise<void> {
    const { sourceDb, destDb, config, stats, logger, progressBar, transformFn } = ctx;

    // Get the destination path (may be renamed)
    const destCollectionPath = getDestCollectionPath(collectionPath, config.renameCollection);

    const sourceCollectionRef = sourceDb.collection(collectionPath);
    let query: FirebaseFirestore.Query = sourceCollectionRef;

    // Apply where filters (only at root level)
    if (depth === 0 && config.where.length > 0) {
        for (const filter of config.where) {
            query = query.where(filter.field, filter.operator, filter.value);
        }
    }

    if (config.limit > 0 && depth === 0) {
        query = query.limit(config.limit);
    }

    const snapshot = await withRetry(() => query.get(), {
        retries: config.retries,
        onRetry: (attempt, max, err, delay) => {
            logger.error(`Retry ${attempt}/${max} for ${collectionPath}`, {
                error: err.message,
                delay,
            });
        },
    });

    if (snapshot.empty) {
        return;
    }

    stats.collectionsProcessed++;
    logger.info(`Processing collection: ${collectionPath}`, { documents: snapshot.size });

    const docs = snapshot.docs;
    for (let i = 0; i < docs.length; i += config.batchSize) {
        const batch = docs.slice(i, i + config.batchSize);
        const destBatch: WriteBatch = destDb.batch();

        for (const doc of batch) {
            // Get destination document ID (with optional prefix/suffix)
            const destDocId = getDestDocId(doc.id, config.idPrefix, config.idSuffix);
            const destDocRef = destDb.collection(destCollectionPath).doc(destDocId);

            // Apply transform if provided
            let docData = doc.data() as Record<string, unknown>;
            if (transformFn) {
                const transformed = transformFn(docData, {
                    id: doc.id,
                    path: `${collectionPath}/${doc.id}`,
                });
                if (transformed === null) {
                    // Skip this document if transform returns null
                    logger.info('Skipped document (transform returned null)', {
                        collection: collectionPath,
                        docId: doc.id,
                    });
                    if (progressBar) {
                        progressBar.increment();
                    }
                    continue;
                }
                docData = transformed;
            }

            if (!config.dryRun) {
                // Use merge option if enabled
                if (config.merge) {
                    destBatch.set(destDocRef, docData, { merge: true });
                } else {
                    destBatch.set(destDocRef, docData);
                }
            }

            stats.documentsTransferred++;
            if (progressBar) {
                progressBar.increment();
            }

            logger.info('Transferred document', {
                source: collectionPath,
                dest: destCollectionPath,
                sourceDocId: doc.id,
                destDocId: destDocId,
            });

            if (config.includeSubcollections) {
                const subcollections = await getSubcollections(doc.ref);

                for (const subcollectionId of subcollections) {
                    // Check exclude patterns
                    if (matchesExcludePattern(subcollectionId, config.exclude)) {
                        logger.info(`Skipping excluded subcollection: ${subcollectionId}`);
                        continue;
                    }

                    const subcollectionPath = `${collectionPath}/${doc.id}/${subcollectionId}`;

                    await transferCollection(
                        { ...ctx, config: { ...config, limit: 0, where: [] } },
                        subcollectionPath,
                        depth + 1
                    );
                }
            }
        }

        if (!config.dryRun && batch.length > 0) {
            await withRetry(() => destBatch.commit(), {
                retries: config.retries,
                onRetry: (attempt, max, err, delay) => {
                    logger.error(`Retry commit ${attempt}/${max}`, { error: err.message, delay });
                },
            });
        }
    }
}

// =============================================================================
// Parallel Processing Helper
// =============================================================================

async function processInParallel<T, R>(
    items: T[],
    concurrency: number,
    processor: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = [];
    const executing: Promise<void>[] = [];

    for (const item of items) {
        const promise = processor(item).then((result) => {
            results.push(result);
        });

        executing.push(promise);

        if (executing.length >= concurrency) {
            await Promise.race(executing);
            // Remove completed promises
            for (let i = executing.length - 1; i >= 0; i--) {
                const p = executing[i];
                // Check if promise is settled by racing with resolved promise
                const isSettled = await Promise.race([
                    p.then(() => true).catch(() => true),
                    Promise.resolve(false),
                ]);
                if (isSettled) {
                    executing.splice(i, 1);
                }
            }
        }
    }

    await Promise.all(executing);
    return results;
}

// =============================================================================
// Main
// =============================================================================

// Handle --init command
if (argv.init !== undefined) {
    const filename = argv.init || 'fscopy.ini';
    generateConfigFile(filename);
    process.exit(0);
}

// Main transfer flow
try {
    const fileConfig = loadConfigFile(argv.config);
    let config = mergeConfig(defaults, fileConfig, argv);

    // Run interactive mode if enabled
    if (argv.interactive) {
        config = await runInteractiveMode(config);
    }

    displayConfig(config);

    const errors = validateConfig(config);
    if (errors.length > 0) {
        console.log('\n❌ Configuration errors:');
        errors.forEach((err) => console.log(`   - ${err}`));
        process.exit(1);
    }

    // Skip confirmation in interactive mode (already confirmed by selection)
    if (!argv.yes && !argv.interactive) {
        const confirmed = await askConfirmation(config);
        if (!confirmed) {
            console.log('\n🚫 Transfer cancelled by user\n');
            process.exit(0);
        }
    }

    const logger = new Logger(argv.log);
    logger.init();
    logger.info('Transfer started', { config: config as unknown as Record<string, unknown> });

    // Load transform function if specified
    let transformFn: TransformFunction | null = null;
    if (config.transform) {
        console.log(`\n🔧 Loading transform: ${config.transform}`);
        transformFn = await loadTransformFunction(config.transform);
        console.log('   Transform loaded successfully');
    }

    console.log('\n');
    const startTime = Date.now();

    const { sourceDb, destDb } = initializeFirebase(config);

    const stats: Stats = {
        collectionsProcessed: 0,
        documentsTransferred: 0,
        documentsDeleted: 0,
        errors: 0,
    };

    // Count total documents for progress bar
    let totalDocs = 0;
    let progressBar: cliProgress.SingleBar | null = null;

    if (!argv.quiet) {
        console.log('📊 Counting documents...');
        for (const collection of config.collections) {
            totalDocs += await countDocuments(sourceDb, collection, config);
        }
        console.log(`   Found ${totalDocs} documents to transfer\n`);

        if (totalDocs > 0) {
            progressBar = new cliProgress.SingleBar({
                format: '📦 Progress |{bar}| {percentage}% | {value}/{total} docs | ETA: {eta}s',
                barCompleteChar: '█',
                barIncompleteChar: '░',
                hideCursor: true,
            });
            progressBar.start(totalDocs, 0);
        }
    }

    // Clear destination collections if enabled
    if (config.clear) {
        console.log('🗑️  Clearing destination collections...');
        for (const collection of config.collections) {
            const destCollection = getDestCollectionPath(collection, config.renameCollection);
            const deleted = await clearCollection(
                destDb,
                destCollection,
                config,
                logger,
                config.includeSubcollections
            );
            stats.documentsDeleted += deleted;
        }
        console.log(`   Deleted ${stats.documentsDeleted} documents\n`);
    }

    const ctx: TransferContext = { sourceDb, destDb, config, stats, logger, progressBar, transformFn };

    // Transfer collections (with optional parallelism)
    if (config.parallel > 1) {
        await processInParallel(config.collections, config.parallel, (collection) =>
            transferCollection(ctx, collection)
        );
    } else {
        for (const collection of config.collections) {
            await transferCollection(ctx, collection);
        }
    }

    if (progressBar) {
        progressBar.stop();
    }

    // Delete orphan documents if enabled (sync mode)
    if (config.deleteMissing) {
        console.log('\n🔄 Deleting orphan documents (sync mode)...');
        for (const collection of config.collections) {
            const deleted = await deleteOrphanDocuments(
                sourceDb,
                destDb,
                collection,
                config,
                logger
            );
            stats.documentsDeleted += deleted;
        }
        if (stats.documentsDeleted > 0) {
            console.log(`   Deleted ${stats.documentsDeleted} orphan documents`);
        } else {
            console.log('   No orphan documents found');
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    logger.success('Transfer completed', {
        stats: stats as unknown as Record<string, unknown>,
        duration,
    });
    logger.summary(stats, duration);

    console.log('\n' + '='.repeat(60));
    console.log('📊 TRANSFER SUMMARY');
    console.log('='.repeat(60));
    console.log(`Collections processed: ${stats.collectionsProcessed}`);
    if (stats.documentsDeleted > 0) {
        console.log(`Documents deleted:     ${stats.documentsDeleted}`);
    }
    console.log(`Documents transferred: ${stats.documentsTransferred}`);
    console.log(`Errors: ${stats.errors}`);
    console.log(`Duration: ${duration}s`);

    if (argv.log) {
        console.log(`Log file: ${argv.log}`);
    }

    if (config.dryRun) {
        console.log('\n⚠ DRY RUN: No data was actually written');
        console.log('   Run with --dry-run=false to perform the transfer');
    } else {
        console.log('\n✓ Transfer completed successfully');
    }
    console.log('='.repeat(60) + '\n');

    await cleanupFirebase();
} catch (error) {
    console.error('\n❌ Error during transfer:', (error as Error).message);
    await cleanupFirebase();
    process.exit(1);
}
