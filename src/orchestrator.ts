import cliProgress from 'cli-progress';
import type { Firestore } from 'firebase-admin/firestore';

import type { Config, Stats, TransferState, TransformFunction, CliArgs } from './types.js';
import { Logger } from './utils/logger.js';
import { RateLimiter } from './utils/rate-limiter.js';
import { loadTransferState, saveTransferState, createInitialState, validateStateForResume, deleteTransferState } from './state/index.js';
import { sendWebhook } from './webhook/index.js';
import { countDocuments, transferCollection, clearCollection, deleteOrphanDocuments, processInParallel, getDestCollectionPath, type TransferContext, type CountProgress } from './transfer/index.js';
import { initializeFirebase, checkDatabaseConnectivity, cleanupFirebase } from './firebase/index.js';
import { loadTransformFunction } from './transform/loader.js';
import { printSummary, formatJsonOutput } from './output/display.js';

export interface TransferResult {
    success: boolean;
    stats: Stats;
    duration: number;
    error?: string;
    verifyResult?: Record<string, { source: number; dest: number; match: boolean }> | null;
}

export async function runTransfer(config: Config, argv: CliArgs, logger: Logger): Promise<TransferResult> {
    let stats: Stats = { collectionsProcessed: 0, documentsTransferred: 0, documentsDeleted: 0, errors: 0 };
    const startTime = Date.now();

    try {
        // Handle resume mode
        let transferState: TransferState | null = null;
        if (config.resume) {
            const existingState = loadTransferState(config.stateFile);
            if (!existingState) {
                throw new Error(`No state file found at ${config.stateFile}. Cannot resume without a saved state. Run without --resume to start fresh.`);
            }

            const stateErrors = validateStateForResume(existingState, config);
            if (stateErrors.length > 0) {
                throw new Error(`Cannot resume: state file incompatible with current config:\n   - ${stateErrors.join('\n   - ')}`);
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

        const { sourceDb, destDb } = initializeFirebase(config);

        // Verify database connectivity before proceeding
        await checkDatabaseConnectivity(sourceDb, destDb, config);

        // Validate transform with sample documents (in dry-run mode)
        if (transformFn && config.dryRun) {
            await validateTransformWithSamples(sourceDb, config, transformFn);
        }

        if (!config.resume) {
            stats = {
                collectionsProcessed: 0,
                documentsTransferred: 0,
                documentsDeleted: 0,
                errors: 0,
            };
        }

        // Count and setup progress bar
        const { progressBar } = await setupProgressTracking(sourceDb, config, stats, argv.quiet);

        // Clear destination collections if enabled
        if (config.clear) {
            await clearDestinationCollections(destDb, config, stats, logger);
        }

        // Create rate limiter if enabled
        const rateLimiter = config.rateLimit > 0 ? new RateLimiter(config.rateLimit) : null;
        if (rateLimiter) {
            console.log(`⏱️  Rate limiting enabled: ${config.rateLimit} docs/s\n`);
        }

        const ctx: TransferContext = { sourceDb, destDb, config, stats, logger, progressBar, transformFn, state: transferState, rateLimiter };

        // Transfer collections (with optional parallelism)
        await executeTransfer(ctx, logger);

        // Cleanup progress bar
        cleanupProgressBar(progressBar);

        // Delete orphan documents if enabled (sync mode)
        if (config.deleteMissing) {
            await deleteOrphanDocs(sourceDb, destDb, config, stats, logger);
        }

        const duration = (Date.now() - startTime) / 1000;

        logger.success('Transfer completed', {
            stats: stats as unknown as Record<string, unknown>,
            duration: duration.toFixed(2),
        });
        logger.summary(stats, duration.toFixed(2));

        // Verify transfer if enabled (and not dry-run)
        let verifyResult: Record<string, { source: number; dest: number; match: boolean }> | null = null;
        if (config.verify && !config.dryRun) {
            verifyResult = await verifyTransfer(sourceDb, destDb, config);
        }

        // Delete state file on successful completion
        if (!config.dryRun) {
            deleteTransferState(config.stateFile);
        }

        // Output results
        if (config.json) {
            console.log(formatJsonOutput(true, config, stats, duration, undefined, verifyResult));
        } else {
            printSummary(stats, duration.toFixed(2), argv.log, config.dryRun);
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
                    duration,
                    dryRun: config.dryRun,
                    success: true,
                },
                logger
            );
        }

        await cleanupFirebase();

        return { success: true, stats, duration, verifyResult };
    } catch (error) {
        const errorMessage = (error as Error).message;
        const duration = (Date.now() - startTime) / 1000;

        // Output error
        if (config.json) {
            console.log(formatJsonOutput(false, config, stats, duration, errorMessage));
        } else {
            console.error('\n❌ Error during transfer:', errorMessage);
        }

        // Send webhook notification on error if configured
        if (config.webhook) {
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

        return { success: false, stats, duration, error: errorMessage };
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

async function validateTransformWithSamples(
    sourceDb: Firestore,
    config: Config,
    transformFn: TransformFunction
): Promise<void> {
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

async function setupProgressTracking(
    sourceDb: Firestore,
    config: Config,
    stats: Stats,
    quiet: boolean
): Promise<{ totalDocs: number; progressBar: cliProgress.SingleBar | null }> {
    let totalDocs = 0;
    let progressBar: cliProgress.SingleBar | null = null;

    if (!quiet) {
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

    return { totalDocs, progressBar };
}

async function clearDestinationCollections(
    destDb: Firestore,
    config: Config,
    stats: Stats,
    logger: Logger
): Promise<void> {
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

async function executeTransfer(ctx: TransferContext, logger: Logger): Promise<void> {
    if (ctx.config.parallel > 1) {
        const { errors } = await processInParallel(ctx.config.collections, ctx.config.parallel, (collection) =>
            transferCollection(ctx, collection)
        );
        if (errors.length > 0) {
            for (const err of errors) {
                logger.error('Parallel transfer error', { error: err.message });
                ctx.stats.errors++;
            }
        }
    } else {
        for (const collection of ctx.config.collections) {
            try {
                await transferCollection(ctx, collection);
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                logger.error(`Transfer failed for ${collection}`, { error: err.message });
                ctx.stats.errors++;
            }
        }
    }
}

function cleanupProgressBar(progressBar: cliProgress.SingleBar | null): void {
    if (progressBar) {
        const interval = (progressBar as unknown as { _speedInterval?: NodeJS.Timeout })._speedInterval;
        if (interval) {
            clearInterval(interval);
        }
        progressBar.stop();
    }
}

async function deleteOrphanDocs(
    sourceDb: Firestore,
    destDb: Firestore,
    config: Config,
    stats: Stats,
    logger: Logger
): Promise<void> {
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

async function verifyTransfer(
    sourceDb: Firestore,
    destDb: Firestore,
    config: Config
): Promise<Record<string, { source: number; dest: number; match: boolean }>> {
    if (!config.json) {
        console.log('\n🔍 Verifying transfer...');
    }

    const verifyResult: Record<string, { source: number; dest: number; match: boolean }> = {};
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

    return verifyResult;
}
