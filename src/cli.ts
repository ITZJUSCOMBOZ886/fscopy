#!/usr/bin/env bun

// Suppress GCE metadata lookup warning (we're not running on Google Cloud)
process.env.METADATA_SERVER_DETECTION = 'none';

import admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import cliProgress from 'cli-progress';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// Import from modules
import type { Config, Stats, TransferState, TransformFunction, CliArgs } from './types.js';
import { Logger } from './utils/logger.js';
import { ensureCredentials } from './utils/credentials.js';
import { formatFirebaseError } from './utils/errors.js';
import { RateLimiter } from './utils/rate-limiter.js';
import { loadConfigFile, mergeConfig } from './config/parser.js';
import { validateConfig } from './config/validator.js';
import { defaults } from './config/defaults.js';
import { generateConfigFile } from './config/generator.js';
import { loadTransferState, saveTransferState, createInitialState, validateStateForResume, deleteTransferState } from './state/index.js';
import { sendWebhook, validateWebhookUrl } from './webhook/index.js';
import { countDocuments, transferCollection, clearCollection, deleteOrphanDocuments, processInParallel, getDestCollectionPath, type TransferContext, type CountProgress } from './transfer/index.js';
import { runInteractiveMode } from './interactive.js';

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
    .option('verify', {
        type: 'boolean',
        description: 'Verify document counts after transfer',
        default: false,
    })
    .option('rate-limit', {
        type: 'number',
        description: 'Limit transfer rate (documents per second, 0 = unlimited)',
        default: 0,
    })
    .option('skip-oversized', {
        type: 'boolean',
        description: 'Skip documents exceeding 1MB instead of failing',
        default: false,
    })
    .option('json', {
        type: 'boolean',
        description: 'Output results in JSON format (for CI/CD)',
        default: false,
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
    if (config.rateLimit > 0) {
        console.log(`  ⏱️  Rate limit:          ${config.rateLimit} docs/s`);
    }
    if (config.skipOversized) {
        console.log(`  📏 Skip oversized:       enabled (skip docs > 1MB)`);
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
        const errorInfo = formatFirebaseError(err);
        const hint = errorInfo.suggestion ? `\n   Hint: ${errorInfo.suggestion}` : '';
        throw new Error(`Cannot connect to source database (${config.sourceProject}): ${errorInfo.message}${hint}`);
    }

    // Check destination database (only if different from source)
    if (config.sourceProject !== config.destProject) {
        try {
            await destDb.listCollections();
            console.log(`   ✓ Destination (${config.destProject}) - connected`);
        } catch (error) {
            const err = error as Error & { code?: string };
            const errorInfo = formatFirebaseError(err);
            const hint = errorInfo.suggestion ? `\n   Hint: ${errorInfo.suggestion}` : '';
            throw new Error(`Cannot connect to destination database (${config.destProject}): ${errorInfo.message}${hint}`);
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

    // Validate webhook URL if configured
    if (config.webhook) {
        const webhookValidation = validateWebhookUrl(config.webhook);
        if (!webhookValidation.valid) {
            console.log(`\n❌ ${webhookValidation.warning}`);
            process.exit(1);
        }
        if (webhookValidation.warning) {
            console.log(`\n⚠️  ${webhookValidation.warning}`);
        }
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

    // Validate transform with sample documents (in dry-run mode)
    if (transformFn && config.dryRun) {
        console.log('🧪 Validating transform with sample documents...');
        let samplesTested = 0;
        let samplesSkipped = 0;
        let samplesErrors = 0;

        for (const collection of config.collections) {
            const snapshot = await sourceDb.collection(collection).limit(3).get();
            for (const doc of snapshot.docs) {
                try {
                    const result = transformFn(doc.data() as Record<string, unknown>, {
                        id: doc.id,
                        path: `${collection}/${doc.id}`,
                    });
                    if (result === null) {
                        samplesSkipped++;
                    } else {
                        samplesTested++;
                    }
                } catch (error) {
                    samplesErrors++;
                    const err = error as Error;
                    console.error(`   ⚠️  Transform error on ${collection}/${doc.id}: ${err.message}`);
                }
            }
        }

        if (samplesErrors > 0) {
            console.log(`   ❌ ${samplesErrors} sample(s) failed - review your transform function`);
        } else if (samplesTested > 0 || samplesSkipped > 0) {
            console.log(`   ✓ Tested ${samplesTested} sample(s), ${samplesSkipped} would be skipped`);
        }
        console.log('');
    }

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
                format: '📦 Progress |{bar}| {percentage}% | {value}/{total} docs | {speed} docs/s | ETA: {eta}s',
                barCompleteChar: '█',
                barIncompleteChar: '░',
                hideCursor: true,
            });
            progressBar.start(totalDocs, 0, { speed: '0' });

            // Track speed using transfer stats
            let lastDocsTransferred = 0;
            let lastTime = Date.now();

            const speedInterval = setInterval(() => {
                if (progressBar) {
                    const now = Date.now();
                    const timeDiff = (now - lastTime) / 1000;
                    const currentDocs = stats.documentsTransferred;

                    if (timeDiff > 0) {
                        const docsDiff = currentDocs - lastDocsTransferred;
                        const speed = Math.round(docsDiff / timeDiff);
                        lastDocsTransferred = currentDocs;
                        lastTime = now;
                        progressBar.update({ speed: String(speed) });
                    }
                }
            }, 500);

            // Store interval for cleanup
            (progressBar as unknown as { _speedInterval: NodeJS.Timeout })._speedInterval = speedInterval;
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

    // Create rate limiter if enabled
    const rateLimiter = config.rateLimit > 0 ? new RateLimiter(config.rateLimit) : null;
    if (rateLimiter) {
        console.log(`⏱️  Rate limiting enabled: ${config.rateLimit} docs/s\n`);
    }

    const ctx: TransferContext = { sourceDb, destDb, config, stats, logger, progressBar, transformFn, state: transferState, rateLimiter };

    // Transfer collections (with optional parallelism)
    if (config.parallel > 1) {
        const { errors } = await processInParallel(config.collections, config.parallel, (collection) =>
            transferCollection(ctx, collection)
        );
        if (errors.length > 0) {
            for (const err of errors) {
                logger.error('Parallel transfer error', { error: err.message });
                stats.errors++;
            }
        }
    } else {
        for (const collection of config.collections) {
            try {
                await transferCollection(ctx, collection);
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                logger.error(`Transfer failed for ${collection}`, { error: err.message });
                stats.errors++;
            }
        }
    }

    if (progressBar) {
        // Clear speed update interval
        const interval = (progressBar as unknown as { _speedInterval?: NodeJS.Timeout })._speedInterval;
        if (interval) {
            clearInterval(interval);
        }
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

    // Verify transfer if enabled (and not dry-run)
    let verifyResult: Record<string, { source: number; dest: number; match: boolean }> | null = null;
    if (config.verify && !config.dryRun) {
        if (!config.json) {
            console.log('\n🔍 Verifying transfer...');
        }
        verifyResult = {};
        let verifyPassed = true;

        for (const collection of config.collections) {
            const destCollection = getDestCollectionPath(collection, config.renameCollection);

            // Count source documents
            const sourceCount = await sourceDb.collection(collection).count().get();
            const sourceTotal = sourceCount.data().count;

            // Count destination documents
            const destCount = await destDb.collection(destCollection).count().get();
            const destTotal = destCount.data().count;

            const match = sourceTotal === destTotal;
            verifyResult[collection] = { source: sourceTotal, dest: destTotal, match };

            if (!config.json) {
                if (match) {
                    console.log(`   ✓ ${collection}: ${sourceTotal} docs (matched)`);
                } else {
                    console.log(`   ⚠️  ${collection}: source=${sourceTotal}, dest=${destTotal} (mismatch)`);
                }
            }
            if (!match) verifyPassed = false;
        }

        if (!config.json) {
            if (verifyPassed) {
                console.log('   ✓ Verification passed');
            } else {
                console.log('   ⚠️  Verification found mismatches');
            }
        }
    }

    // Delete state file on successful completion (before JSON output)
    if (!config.dryRun) {
        deleteTransferState(config.stateFile);
    }

    // JSON output mode
    if (config.json) {
        const jsonOutput = {
            success: true,
            dryRun: config.dryRun,
            source: config.sourceProject,
            destination: config.destProject,
            collections: config.collections,
            stats: {
                collectionsProcessed: stats.collectionsProcessed,
                documentsTransferred: stats.documentsTransferred,
                documentsDeleted: stats.documentsDeleted,
                errors: stats.errors,
            },
            duration: Number.parseFloat(duration),
            verify: verifyResult,
        };
        console.log(JSON.stringify(jsonOutput, null, 2));
    } else {
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
    }

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
    const duration = Number.parseFloat(((Date.now() - startTime) / 1000).toFixed(2));

    // JSON output mode for errors
    if (config.json) {
        const jsonOutput = {
            success: false,
            error: errorMessage,
            dryRun: config.dryRun,
            source: config.sourceProject,
            destination: config.destProject,
            collections: config.collections,
            stats: {
                collectionsProcessed: stats.collectionsProcessed,
                documentsTransferred: stats.documentsTransferred,
                documentsDeleted: stats.documentsDeleted,
                errors: stats.errors,
            },
            duration,
        };
        console.log(JSON.stringify(jsonOutput, null, 2));
    } else {
        console.error('\n❌ Error during transfer:', errorMessage);
    }

    // Send webhook notification on error if configured
    if (config.webhook && logger) {
        await sendWebhook(
            config.webhook,
            {
                source: config.sourceProject ?? 'unknown',
                destination: config.destProject ?? 'unknown',
                collections: config.collections,
                stats,
                duration,
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
