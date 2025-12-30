import type { Firestore, WriteBatch } from 'firebase-admin/firestore';
import type cliProgress from 'cli-progress';
import type { Config, Stats, TransferState, TransformFunction } from '../types.js';
import type { Logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { matchesExcludePattern } from '../utils/patterns.js';
import { isDocCompleted, markDocCompleted, saveTransferState } from '../state/index.js';
import { getSubcollections, getDestCollectionPath, getDestDocId } from './helpers.js';

export interface TransferContext {
    sourceDb: Firestore;
    destDb: Firestore;
    config: Config;
    stats: Stats;
    logger: Logger;
    progressBar: cliProgress.SingleBar | null;
    transformFn: TransformFunction | null;
    state: TransferState | null;
}

export async function transferCollection(
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
                try {
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
                } catch (transformError) {
                    const errMsg =
                        transformError instanceof Error
                            ? transformError.message
                            : String(transformError);
                    logger.error(`Transform failed for document ${doc.id}`, {
                        collection: collectionPath,
                        error: errMsg,
                    });
                    stats.errors++;
                    if (progressBar) {
                        progressBar.increment();
                    }
                    // Skip this document but continue with others
                    continue;
                }
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
