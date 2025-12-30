import type { Firestore, WriteBatch, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type cliProgress from 'cli-progress';
import type { Config, Stats, TransferState, TransformFunction } from '../types.js';
import type { Logger } from '../utils/logger.js';
import type { RateLimiter } from '../utils/rate-limiter.js';
import { withRetry } from '../utils/retry.js';
import { matchesExcludePattern } from '../utils/patterns.js';
import { estimateDocumentSize, formatBytes, FIRESTORE_MAX_DOC_SIZE } from '../utils/doc-size.js';
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
    rateLimiter: RateLimiter | null;
}

interface DocProcessResult {
    skip: boolean;
    data?: Record<string, unknown>;
    markCompleted: boolean;
}

function buildTransferQuery(
    sourceDb: Firestore,
    collectionPath: string,
    config: Config,
    depth: number
): Query {
    let query: Query = sourceDb.collection(collectionPath);

    if (depth === 0 && config.where.length > 0) {
        for (const filter of config.where) {
            query = query.where(filter.field, filter.operator, filter.value);
        }
    }

    if (config.limit > 0 && depth === 0) {
        query = query.limit(config.limit);
    }

    return query;
}

function applyTransform(
    docData: Record<string, unknown>,
    doc: QueryDocumentSnapshot,
    collectionPath: string,
    transformFn: TransformFunction,
    logger: Logger,
    stats: Stats
): { success: boolean; data: Record<string, unknown> | null; markCompleted: boolean } {
    try {
        const transformed = transformFn(docData, {
            id: doc.id,
            path: `${collectionPath}/${doc.id}`,
        });

        if (transformed === null) {
            logger.info('Skipped document (transform returned null)', {
                collection: collectionPath,
                docId: doc.id,
            });
            return { success: false, data: null, markCompleted: true };
        }

        return { success: true, data: transformed, markCompleted: false };
    } catch (transformError) {
        const errMsg = transformError instanceof Error ? transformError.message : String(transformError);
        logger.error(`Transform failed for document ${doc.id}`, {
            collection: collectionPath,
            error: errMsg,
        });
        stats.errors++;
        return { success: false, data: null, markCompleted: false };
    }
}

function checkDocumentSize(
    docData: Record<string, unknown>,
    doc: QueryDocumentSnapshot,
    collectionPath: string,
    destCollectionPath: string,
    destDocId: string,
    config: Config,
    logger: Logger
): { valid: boolean; markCompleted: boolean } {
    const docSize = estimateDocumentSize(docData, `${destCollectionPath}/${destDocId}`);

    if (docSize <= FIRESTORE_MAX_DOC_SIZE) {
        return { valid: true, markCompleted: false };
    }

    const sizeStr = formatBytes(docSize);
    if (config.skipOversized) {
        logger.info(`Skipped oversized document (${sizeStr})`, {
            collection: collectionPath,
            docId: doc.id,
        });
        return { valid: false, markCompleted: true };
    }

    throw new Error(
        `Document ${collectionPath}/${doc.id} exceeds 1MB limit (${sizeStr}). Use --skip-oversized to skip.`
    );
}

async function processSubcollections(
    ctx: TransferContext,
    doc: QueryDocumentSnapshot,
    collectionPath: string,
    depth: number
): Promise<void> {
    const subcollections = await getSubcollections(doc.ref);

    for (const subcollectionId of subcollections) {
        if (matchesExcludePattern(subcollectionId, ctx.config.exclude)) {
            ctx.logger.info(`Skipping excluded subcollection: ${subcollectionId}`);
            continue;
        }

        const subcollectionPath = `${collectionPath}/${doc.id}/${subcollectionId}`;
        const subCtx = { ...ctx, config: { ...ctx.config, limit: 0, where: [] } };
        await transferCollection(subCtx, subcollectionPath, depth + 1);
    }
}

function processDocument(
    doc: QueryDocumentSnapshot,
    ctx: TransferContext,
    collectionPath: string,
    destCollectionPath: string
): DocProcessResult {
    const { config, logger, state, stats, transformFn } = ctx;

    // Skip if already completed (resume mode)
    if (state && isDocCompleted(state, collectionPath, doc.id)) {
        stats.documentsTransferred++;
        return { skip: true, markCompleted: false };
    }

    const destDocId = getDestDocId(doc.id, config.idPrefix, config.idSuffix);
    let docData = doc.data() as Record<string, unknown>;

    // Apply transform if provided
    if (transformFn) {
        const transformResult = applyTransform(docData, doc, collectionPath, transformFn, logger, stats);
        if (!transformResult.success) {
            return { skip: true, markCompleted: transformResult.markCompleted };
        }
        docData = transformResult.data!;
    }

    // Check document size
    const sizeResult = checkDocumentSize(docData, doc, collectionPath, destCollectionPath, destDocId, config, logger);
    if (!sizeResult.valid) {
        return { skip: true, markCompleted: sizeResult.markCompleted };
    }

    return { skip: false, data: docData, markCompleted: true };
}

function incrementProgress(progressBar: cliProgress.SingleBar | null): void {
    if (progressBar) progressBar.increment();
}

async function commitBatchWithRetry(
    destBatch: WriteBatch,
    batchDocIds: string[],
    ctx: TransferContext,
    collectionPath: string
): Promise<void> {
    const { config, logger, state, stats, rateLimiter } = ctx;

    if (rateLimiter) {
        await rateLimiter.acquire(batchDocIds.length);
    }

    await withRetry(() => destBatch.commit(), {
        retries: config.retries,
        onRetry: (attempt, max, err, delay) => {
            logger.error(`Retry commit ${attempt}/${max}`, { error: err.message, delay });
        },
    });

    if (state && batchDocIds.length > 0) {
        for (const docId of batchDocIds) {
            markDocCompleted(state, collectionPath, docId);
        }
        state.stats = { ...stats };
        saveTransferState(config.stateFile, state);
    }
}

async function processBatch(
    batch: QueryDocumentSnapshot[],
    ctx: TransferContext,
    collectionPath: string,
    destCollectionPath: string,
    depth: number
): Promise<string[]> {
    const { destDb, config, stats, logger, progressBar } = ctx;
    const destBatch = destDb.batch();
    const batchDocIds: string[] = [];

    for (const doc of batch) {
        const result = processDocument(doc, ctx, collectionPath, destCollectionPath);
        incrementProgress(progressBar);

        if (result.skip) {
            if (result.markCompleted) batchDocIds.push(doc.id);
            continue;
        }

        const destDocId = getDestDocId(doc.id, config.idPrefix, config.idSuffix);
        const destDocRef = destDb.collection(destCollectionPath).doc(destDocId);

        if (!config.dryRun) {
            if (config.merge) {
                destBatch.set(destDocRef, result.data!, { merge: true });
            } else {
                destBatch.set(destDocRef, result.data!);
            }
        }

        batchDocIds.push(doc.id);
        stats.documentsTransferred++;

        logger.info('Transferred document', {
            source: collectionPath,
            dest: destCollectionPath,
            sourceDocId: doc.id,
            destDocId,
        });

        if (config.includeSubcollections) {
            await processSubcollections(ctx, doc, collectionPath, depth);
        }
    }

    if (!config.dryRun && batch.length > 0) {
        await commitBatchWithRetry(destBatch, batchDocIds, ctx, collectionPath);
    }

    return batchDocIds;
}

export async function transferCollection(
    ctx: TransferContext,
    collectionPath: string,
    depth: number = 0
): Promise<void> {
    const { sourceDb, config, stats, logger } = ctx;
    const destCollectionPath = getDestCollectionPath(collectionPath, config.renameCollection);

    const query = buildTransferQuery(sourceDb, collectionPath, config, depth);

    const snapshot = await withRetry(() => query.get(), {
        retries: config.retries,
        onRetry: (attempt, max, err, delay) => {
            logger.error(`Retry ${attempt}/${max} for ${collectionPath}`, { error: err.message, delay });
        },
    });

    if (snapshot.empty) return;

    stats.collectionsProcessed++;
    logger.info(`Processing collection: ${collectionPath}`, { documents: snapshot.size });

    for (let i = 0; i < snapshot.docs.length; i += config.batchSize) {
        const batch = snapshot.docs.slice(i, i + config.batchSize);
        await processBatch(batch, ctx, collectionPath, destCollectionPath, depth);
    }
}
