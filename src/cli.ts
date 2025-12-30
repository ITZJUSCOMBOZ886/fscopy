#!/usr/bin/env bun

// Suppress GCE metadata lookup warning (we're not running on Google Cloud)
process.env.METADATA_SERVER_DETECTION = 'none';

import admin from 'firebase-admin';
import type { Firestore, DocumentReference, WriteBatch } from 'firebase-admin/firestore';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import ini from 'ini';
import cliProgress from 'cli-progress';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { input, confirm, checkbox } from '@inquirer/prompts';

// =============================================================================
// Credentials Check
// =============================================================================

function checkCredentialsExist(): { exists: boolean; path: string } {
    // Check for explicit credentials file
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        return { exists: fs.existsSync(credPath), path: credPath };
    }

    // Check for Application Default Credentials
    const adcPath = path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
    return { exists: fs.existsSync(adcPath), path: adcPath };
}

function ensureCredentials(): void {
    const { exists, path: credPath } = checkCredentialsExist();

    if (!exists) {
        console.error('\n❌ Google Cloud credentials not found.');
        console.error(`   Expected at: ${credPath}\n`);
        console.error('   Run this command to authenticate:');
        console.error('   gcloud auth application-default login\n');
        process.exit(1);
    }
}

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
    webhook: string | null;
    resume: boolean;
    stateFile: string;
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

interface TransferState {
    version: number;
    sourceProject: string;
    destProject: string;
    collections: string[];
    startedAt: string;
    updatedAt: string;
    completedDocs: Record<string, string[]>; // collectionPath -> array of doc IDs
    stats: Stats;
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
    webhook?: string;
    resume?: boolean;
    stateFile?: string;
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
    .option('webhook', {
        type: 'string',
        description: 'Webhook URL for transfer notifications (Slack, Discord, or custom)',
    })
    .option('resume', {
        type: 'boolean',
        description: 'Resume an interrupted transfer from saved state',
        default: false,
    })
    .option('state-file', {
        type: 'string',
        description: 'Path to state file for resume (default: .fscopy-state.json)',
        default: '.fscopy-state.json',
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
    .example('$0 -f config.ini --webhook https://hooks.slack.com/...', 'Send notification to Slack')
    .example('$0 -f config.ini --resume', 'Resume an interrupted transfer')
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
    webhook: null,
    resume: false,
    stateFile: '.fscopy-state.json',
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
; Webhook URL for transfer notifications (Slack, Discord, or custom)
; webhook = https://hooks.slack.com/services/...
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
    webhook: null,
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
            webhook?: string;
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
        webhook: parsed.options?.webhook ?? null,
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
        webhook?: string;
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
        webhook: config.webhook ?? null,
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
        webhook: cliArgs.webhook ?? fileConfig.webhook ?? defaultConfig.webhook,
        resume: cliArgs.resume ?? defaultConfig.resume,
        stateFile: cliArgs.stateFile ?? defaultConfig.stateFile,
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
            validate: (value) => value.length > 0 || 'Project ID is required',
        });
    } else {
        console.log(`📥 Destination project: ${destProject}`);
    }

    // If source = destination, ask for rename/id modifications
    let renameCollection = config.renameCollection;
    let idPrefix = config.idPrefix;
    let idSuffix = config.idSuffix;

    if (sourceProject === destProject) {
        console.log('\n⚠️  Source and destination are the same project.');
        console.log('   You need to rename collections or modify document IDs to avoid overwriting.\n');

        const modifyIds = await confirm({
            message: 'Add a prefix to document IDs?',
            default: true,
        });

        if (modifyIds) {
            idPrefix = await input({
                message: 'Document ID prefix (e.g., "backup_"):',
                default: 'backup_',
                validate: (value) => value.length > 0 || 'Prefix is required',
            });
        } else {
            // Ask for suffix as alternative
            const useSuffix = await confirm({
                message: 'Add a suffix to document IDs instead?',
                default: true,
            });

            if (useSuffix) {
                idSuffix = await input({
                    message: 'Document ID suffix (e.g., "_backup"):',
                    default: '_backup',
                    validate: (value) => value.length > 0 || 'Suffix is required',
                });
            } else {
                console.log('\n❌ Cannot proceed: source and destination are the same without ID modification.');
                console.log('   This would overwrite your data. Use --rename-collection, --id-prefix, or --id-suffix.\n');
                process.exit(1);
            }
        }
    }

    // Initialize source Firebase to list collections
    console.log('\n📊 Connecting to source project...');

    let tempSourceApp: admin.app.App;
    let sourceDb: Firestore;
    let rootCollections: FirebaseFirestore.CollectionReference[];

    try {
        tempSourceApp = admin.initializeApp(
            {
                credential: admin.credential.applicationDefault(),
                projectId: sourceProject,
            },
            'interactive-source'
        );
        sourceDb = tempSourceApp.firestore();

        // List collections (also tests connectivity)
        rootCollections = await sourceDb.listCollections();
    } catch (error) {
        const err = error as Error & { code?: string };
        console.error('\n❌ Cannot connect to Firebase project:', err.message);

        if (err.message.includes('default credentials') || err.message.includes('credential')) {
            console.error('\n   Run this command to authenticate:');
            console.error('   gcloud auth application-default login\n');
        } else if (err.message.includes('not found') || err.message.includes('NOT_FOUND')) {
            console.error(`\n   Project "${sourceProject}" not found. Check the project ID.\n`);
        } else if (err.message.includes('permission') || err.message.includes('PERMISSION_DENIED')) {
            console.error('\n   You don\'t have permission to access this project\'s Firestore.\n');
        }

        process.exit(1);
    }

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
        renameCollection,
        idPrefix,
        idSuffix,
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

async function checkDatabaseConnectivity(
    sourceDb: Firestore,
    destDb: Firestore,
    config: Config
): Promise<void> {
    console.log('🔌 Checking database connectivity...');

    // Check source database
    try {
        await sourceDb.listCollections();
        console.log(`   ✓ Source (${config.sourceProject}) - connected`);
    } catch (error) {
        const err = error as Error & { code?: string };
        let hint = '';

        if (err.code === 'app/invalid-credential' || err.message.includes('credential')) {
            hint = '\n   Hint: Run "gcloud auth application-default login" to authenticate';
        } else if (err.code === 'unavailable' || err.message.includes('UNAVAILABLE')) {
            hint = '\n   Hint: Check your internet connection';
        } else if (err.message.includes('not found') || err.message.includes('NOT_FOUND')) {
            hint = '\n   Hint: Verify the project ID is correct';
        } else if (err.message.includes('permission') || err.message.includes('PERMISSION_DENIED')) {
            hint = '\n   Hint: Ensure you have Firestore access on this project';
        }

        throw new Error(
            `Cannot connect to source database (${config.sourceProject}): ${err.message}${hint}`
        );
    }

    // Check destination database (only if different from source)
    if (config.sourceProject !== config.destProject) {
        try {
            await destDb.listCollections();
            console.log(`   ✓ Destination (${config.destProject}) - connected`);
        } catch (error) {
            const err = error as Error & { code?: string };
            let hint = '';

            if (err.code === 'app/invalid-credential' || err.message.includes('credential')) {
                hint = '\n   Hint: Run "gcloud auth application-default login" to authenticate';
            } else if (err.code === 'unavailable' || err.message.includes('UNAVAILABLE')) {
                hint = '\n   Hint: Check your internet connection';
            } else if (err.message.includes('not found') || err.message.includes('NOT_FOUND')) {
                hint = '\n   Hint: Verify the project ID is correct';
            } else if (err.message.includes('permission') || err.message.includes('PERMISSION_DENIED')) {
                hint = '\n   Hint: Ensure you have Firestore access on this project';
            }

            throw new Error(
                `Cannot connect to destination database (${config.destProject}): ${err.message}${hint}`
            );
        }
    } else {
        console.log(`   ✓ Destination (same as source) - connected`);
    }

    console.log('');
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
// Webhook
// =============================================================================

interface WebhookPayload {
    source: string;
    destination: string;
    collections: string[];
    stats: Stats;
    duration: number;
    dryRun: boolean;
    success: boolean;
    error?: string;
}

function detectWebhookType(url: string): 'slack' | 'discord' | 'custom' {
    if (url.includes('hooks.slack.com')) {
        return 'slack';
    }
    if (url.includes('discord.com/api/webhooks')) {
        return 'discord';
    }
    return 'custom';
}

function formatSlackPayload(payload: WebhookPayload): Record<string, unknown> {
    const status = payload.success ? ':white_check_mark: Success' : ':x: Failed';
    const mode = payload.dryRun ? ' (DRY RUN)' : '';

    const fields = [
        { title: 'Source', value: payload.source, short: true },
        { title: 'Destination', value: payload.destination, short: true },
        { title: 'Collections', value: payload.collections.join(', '), short: false },
        { title: 'Transferred', value: String(payload.stats.documentsTransferred), short: true },
        { title: 'Deleted', value: String(payload.stats.documentsDeleted), short: true },
        { title: 'Errors', value: String(payload.stats.errors), short: true },
        { title: 'Duration', value: `${payload.duration}s`, short: true },
    ];

    if (payload.error) {
        fields.push({ title: 'Error', value: payload.error, short: false });
    }

    return {
        attachments: [
            {
                color: payload.success ? '#36a64f' : '#ff0000',
                title: `fscopy Transfer${mode}`,
                text: status,
                fields,
                footer: 'fscopy',
                ts: Math.floor(Date.now() / 1000),
            },
        ],
    };
}

function formatDiscordPayload(payload: WebhookPayload): Record<string, unknown> {
    const status = payload.success ? '✅ Success' : '❌ Failed';
    const mode = payload.dryRun ? ' (DRY RUN)' : '';
    const color = payload.success ? 0x36a64f : 0xff0000;

    const fields = [
        { name: 'Source', value: payload.source, inline: true },
        { name: 'Destination', value: payload.destination, inline: true },
        { name: 'Collections', value: payload.collections.join(', '), inline: false },
        { name: 'Transferred', value: String(payload.stats.documentsTransferred), inline: true },
        { name: 'Deleted', value: String(payload.stats.documentsDeleted), inline: true },
        { name: 'Errors', value: String(payload.stats.errors), inline: true },
        { name: 'Duration', value: `${payload.duration}s`, inline: true },
    ];

    if (payload.error) {
        fields.push({ name: 'Error', value: payload.error, inline: false });
    }

    return {
        embeds: [
            {
                title: `fscopy Transfer${mode}`,
                description: status,
                color,
                fields,
                footer: { text: 'fscopy' },
                timestamp: new Date().toISOString(),
            },
        ],
    };
}

async function sendWebhook(
    webhookUrl: string,
    payload: WebhookPayload,
    logger: Logger
): Promise<void> {
    const webhookType = detectWebhookType(webhookUrl);

    let body: Record<string, unknown>;
    switch (webhookType) {
        case 'slack':
            body = formatSlackPayload(payload);
            break;
        case 'discord':
            body = formatDiscordPayload(payload);
            break;
        default:
            body = payload as unknown as Record<string, unknown>;
    }

    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        logger.info(`Webhook sent successfully (${webhookType})`, { url: webhookUrl });
        console.log(`📤 Webhook notification sent (${webhookType})`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to send webhook: ${message}`, { url: webhookUrl });
        console.error(`⚠️  Failed to send webhook: ${message}`);
    }
}

// =============================================================================
// State Management (Resume Support)
// =============================================================================

const STATE_VERSION = 1;

function loadTransferState(stateFile: string): TransferState | null {
    try {
        if (!fs.existsSync(stateFile)) {
            return null;
        }
        const content = fs.readFileSync(stateFile, 'utf-8');
        const state = JSON.parse(content) as TransferState;

        if (state.version !== STATE_VERSION) {
            console.warn(`⚠️  State file version mismatch (expected ${STATE_VERSION}, got ${state.version})`);
            return null;
        }

        return state;
    } catch (error) {
        console.error(`⚠️  Failed to load state file: ${(error as Error).message}`);
        return null;
    }
}

function saveTransferState(stateFile: string, state: TransferState): void {
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function deleteTransferState(stateFile: string): void {
    try {
        if (fs.existsSync(stateFile)) {
            fs.unlinkSync(stateFile);
        }
    } catch {
        // Ignore errors when deleting state file
    }
}

function createInitialState(config: Config): TransferState {
    return {
        version: STATE_VERSION,
        sourceProject: config.sourceProject!,
        destProject: config.destProject!,
        collections: config.collections,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedDocs: {},
        stats: {
            collectionsProcessed: 0,
            documentsTransferred: 0,
            documentsDeleted: 0,
            errors: 0,
        },
    };
}

function validateStateForResume(state: TransferState, config: Config): string[] {
    const errors: string[] = [];

    if (state.sourceProject !== config.sourceProject) {
        errors.push(`Source project mismatch: state has "${state.sourceProject}", config has "${config.sourceProject}"`);
    }
    if (state.destProject !== config.destProject) {
        errors.push(`Destination project mismatch: state has "${state.destProject}", config has "${config.destProject}"`);
    }

    // Check if collections are compatible (state collections should be subset of config)
    const configCollections = new Set(config.collections);
    for (const col of state.collections) {
        if (!configCollections.has(col)) {
            errors.push(`State contains collection "${col}" not in current config`);
        }
    }

    return errors;
}

function isDocCompleted(state: TransferState, collectionPath: string, docId: string): boolean {
    const completedInCollection = state.completedDocs[collectionPath];
    return completedInCollection ? completedInCollection.includes(docId) : false;
}

function markDocCompleted(state: TransferState, collectionPath: string, docId: string): void {
    if (!state.completedDocs[collectionPath]) {
        state.completedDocs[collectionPath] = [];
    }
    state.completedDocs[collectionPath].push(docId);
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

    // Get all document IDs from source (use select() to only fetch IDs, not data)
    const sourceSnapshot = await sourceDb.collection(sourceCollectionPath).select().get();
    const sourceIds = new Set(sourceSnapshot.docs.map((doc) => doc.id));

    // Get all document IDs from destination (use select() to only fetch IDs, not data)
    const destSnapshot = await destDb.collection(destCollectionPath).select().get();

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

interface CountProgress {
    onCollection?: (path: string, count: number) => void;
    onSubcollection?: (path: string) => void;
}

async function countDocuments(
    sourceDb: Firestore,
    collectionPath: string,
    config: Config,
    depth: number = 0,
    progress?: CountProgress
): Promise<number> {
    let count = 0;

    // Build query with where filters (only at root level)
    let query: FirebaseFirestore.Query = sourceDb.collection(collectionPath);
    if (depth === 0 && config.where.length > 0) {
        for (const filter of config.where) {
            query = query.where(filter.field, filter.operator, filter.value);
        }
    }

    // Use count() aggregation to avoid downloading all documents (much cheaper)
    // But we need document refs for subcollections, so we'll need a different approach
    if (config.includeSubcollections) {
        // When including subcollections, we need to fetch docs to get their refs
        // Use select() to only fetch document IDs, not the data (reduces bandwidth)
        const snapshot = await query.select().get();
        count += snapshot.size;

        // Report progress for root collections
        if (depth === 0 && progress?.onCollection) {
            progress.onCollection(collectionPath, snapshot.size);
        }

        for (const doc of snapshot.docs) {
            const subcollections = await getSubcollections(doc.ref);
            for (const subId of subcollections) {
                const subPath = `${collectionPath}/${doc.id}/${subId}`;

                // Check exclude patterns
                if (matchesExcludePattern(subId, config.exclude)) {
                    continue;
                }

                // Report subcollection discovery
                if (progress?.onSubcollection) {
                    progress.onSubcollection(subPath);
                }

                count += await countDocuments(sourceDb, subPath, config, depth + 1, progress);
            }
        }
    } else {
        // No subcollections: use count() aggregation (1 read instead of N)
        const countSnapshot = await query.count().get();
        count = countSnapshot.data().count;

        // Report progress for root collections
        if (depth === 0 && progress?.onCollection) {
            progress.onCollection(collectionPath, count);
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
    state: TransferState | null;
}

async function transferCollection(
    ctx: TransferContext,
    collectionPath: string,
    depth: number = 0
): Promise<void> {
    const { sourceDb, destDb, config, stats, logger, progressBar, transformFn, state } = ctx;

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
    const batchDocIds: string[] = []; // Track docs in current batch for state saving

    for (let i = 0; i < docs.length; i += config.batchSize) {
        const batch = docs.slice(i, i + config.batchSize);
        const destBatch: WriteBatch = destDb.batch();
        batchDocIds.length = 0; // Clear for new batch

        for (const doc of batch) {
            // Skip if already completed (resume mode)
            if (state && isDocCompleted(state, collectionPath, doc.id)) {
                if (progressBar) {
                    progressBar.increment();
                }
                stats.documentsTransferred++;
                continue;
            }

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
                    // Mark as completed even if skipped
                    batchDocIds.push(doc.id);
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

            batchDocIds.push(doc.id);
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

            // Save state after successful batch commit (for resume support)
            if (state && batchDocIds.length > 0) {
                for (const docId of batchDocIds) {
                    markDocCompleted(state, collectionPath, docId);
                }
                state.stats = { ...stats };
                saveTransferState(config.stateFile, state);
            }
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

// Check credentials before proceeding
ensureCredentials();

// Main transfer flow
let config: Config = defaults;
let logger: Logger | null = null;
let stats: Stats = { collectionsProcessed: 0, documentsTransferred: 0, documentsDeleted: 0, errors: 0 };
let startTime = Date.now();

try {
    const fileConfig = loadConfigFile(argv.config);
    config = mergeConfig(defaults, fileConfig, argv);

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

    logger = new Logger(argv.log);
    logger.init();
    logger.info('Transfer started', { config: config as unknown as Record<string, unknown> });

    // Handle resume mode
    let transferState: TransferState | null = null;
    if (config.resume) {
        const existingState = loadTransferState(config.stateFile);
        if (!existingState) {
            console.error(`\n❌ No state file found at ${config.stateFile}`);
            console.error('   Cannot resume without a saved state. Run without --resume to start fresh.');
            process.exit(1);
        }

        const stateErrors = validateStateForResume(existingState, config);
        if (stateErrors.length > 0) {
            console.error('\n❌ Cannot resume: state file incompatible with current config:');
            stateErrors.forEach((err) => console.error(`   - ${err}`));
            process.exit(1);
        }

        transferState = existingState;
        const completedCount = Object.values(transferState.completedDocs).reduce((sum, ids) => sum + ids.length, 0);
        console.log(`\n🔄 Resuming transfer from ${config.stateFile}`);
        console.log(`   Started: ${transferState.startedAt}`);
        console.log(`   Previously completed: ${completedCount} documents`);
        stats = { ...transferState.stats };
    } else if (!config.dryRun) {
        // Create new state for tracking (only in non-dry-run mode)
        transferState = createInitialState(config);
        saveTransferState(config.stateFile, transferState);
        console.log(`\n💾 State will be saved to ${config.stateFile} (use --resume to continue if interrupted)`);
    }

    // Load transform function if specified
    let transformFn: TransformFunction | null = null;
    if (config.transform) {
        console.log(`\n🔧 Loading transform: ${config.transform}`);
        transformFn = await loadTransformFunction(config.transform);
        console.log('   Transform loaded successfully');
    }

    console.log('\n');
    startTime = Date.now();

    const { sourceDb, destDb } = initializeFirebase(config);

    // Verify database connectivity before proceeding
    await checkDatabaseConnectivity(sourceDb, destDb, config);

    if (!config.resume) {
        stats = {
            collectionsProcessed: 0,
            documentsTransferred: 0,
            documentsDeleted: 0,
            errors: 0,
        };
    }

    // Count total documents for progress bar
    let totalDocs = 0;
    let progressBar: cliProgress.SingleBar | null = null;

    if (!argv.quiet) {
        console.log('📊 Counting documents...');
        let lastSubcollectionLog = Date.now();
        let subcollectionCount = 0;

        const countProgress: CountProgress = {
            onCollection: (path, count) => {
                console.log(`   ${path}: ${count} documents`);
            },
            onSubcollection: (_path) => {
                subcollectionCount++;
                // Show progress every 2 seconds to avoid flooding the console
                const now = Date.now();
                if (now - lastSubcollectionLog > 2000) {
                    process.stdout.write(`\r   Scanning subcollections... (${subcollectionCount} found)`);
                    lastSubcollectionLog = now;
                }
            },
        };

        for (const collection of config.collections) {
            totalDocs += await countDocuments(sourceDb, collection, config, 0, countProgress);
        }

        // Clear the subcollection line if any were found
        if (subcollectionCount > 0) {
            process.stdout.write('\r' + ' '.repeat(60) + '\r');
            console.log(`   Subcollections scanned: ${subcollectionCount}`);
        }
        console.log(`   Total: ${totalDocs} documents to transfer\n`);

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

    const ctx: TransferContext = { sourceDb, destDb, config, stats, logger, progressBar, transformFn, state: transferState };

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
        // Delete state file on successful completion
        deleteTransferState(config.stateFile);
    }
    console.log('='.repeat(60) + '\n');

    // Send webhook notification if configured
    if (config.webhook) {
        await sendWebhook(
            config.webhook,
            {
                source: config.sourceProject!,
                destination: config.destProject!,
                collections: config.collections,
                stats,
                duration: Number.parseFloat(duration),
                dryRun: config.dryRun,
                success: true,
            },
            logger
        );
    }

    await cleanupFirebase();
} catch (error) {
    const errorMessage = (error as Error).message;
    console.error('\n❌ Error during transfer:', errorMessage);

    // Send webhook notification on error if configured
    if (config.webhook && logger) {
        await sendWebhook(
            config.webhook,
            {
                source: config.sourceProject ?? 'unknown',
                destination: config.destProject ?? 'unknown',
                collections: config.collections,
                stats,
                duration: Number.parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
                dryRun: config.dryRun,
                success: false,
                error: errorMessage,
            },
            logger
        );
    }

    await cleanupFirebase();
    process.exit(1);
}
