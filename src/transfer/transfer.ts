import type { Firestore, WriteBatch, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { Config, Stats, TransformFunction } from '../types.js';
import type { Output } from '../utils/output.js';
import type { RateLimiter } from '../utils/rate-limiter.js';
import type { ProgressBarWrapper } from '../utils/progress.js';
import type { StateSaver } from '../state/index.js';
import { withRetry } from '../utils/retry.js';
import { matchesExcludePattern } from '../utils/patterns.js';
import { estimateDocumentSize, formatBytes, FIRESTORE_MAX_DOC_SIZE } from '../utils/doc-size.js';
import { getSubcollections, getDestCollectionPath, getDestDocId } from './helpers.js';

export interface TransferContext {
    sourceDb: Firestore;
    destDb: Firestore;
    config: Config;
    stats: Stats;
    output: Output;
    progressBar: ProgressBarWrapper;
    transformFn: TransformFunction | null;
    stateSaver: StateSaver | null;
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
    output: Output,
    stats: Stats
): { success: boolean; data: Record<string, unknown> | null; markCompleted: boolean } {
    try {
        const transformed = transformFn(docData, {
            id: doc.id,
            path: `${collectionPath}/${doc.id}`,
        });

        if (transformed === null) {
            output.logInfo('Skipped document (transform returned null)', {
                collection: collectionPath,
                docId: doc.id,
            });
            return { success: false, data: null, markCompleted: true };
        }

        return { success: true, data: transformed, markCompleted: false };
    } catch (transformError) {
        const errMsg = transformError instanceof Error ? transformError.message : String(transformError);
        output.logError(`Transform failed for document ${doc.id}`, {
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
    output: Output
): { valid: boolean; markCompleted: boolean } {
    const docSize = estimateDocumentSize(docData, `${destCollectionPath}/${destDocId}`);

    if (docSize <= FIRESTORE_MAX_DOC_SIZE) {
        return { valid: true, markCompleted: false };
    }

    const sizeStr = formatBytes(docSize);
    if (config.skipOversized) {
        output.logInfo(`Skipped oversized document (${sizeStr})`, {
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
            ctx.output.logInfo(`Skipping excluded subcollection: ${subcollectionId}`);
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
    const { config, output, stateSaver, stats, transformFn } = ctx;

    // Skip if already completed (resume mode) - O(1) lookup via Set
    if (stateSaver?.isCompleted(collectionPath, doc.id)) {
        stats.documentsTransferred++;
        return { skip: true, markCompleted: false };
    }

    const destDocId = getDestDocId(doc.id, config.idPrefix, config.idSuffix);
    let docData = doc.data() as Record<string, unknown>;

    // Apply transform if provided
    if (transformFn) {
        const transformResult = applyTransform(docData, doc, collectionPath, transformFn, output, stats);
        if (!transformResult.success) {
            return { skip: true, markCompleted: transformResult.markCompleted };
        }
        docData = transformResult.data!;
    }

    // Check document size
    const sizeResult = checkDocumentSize(docData, doc, collectionPath, destCollectionPath, destDocId, config, output);
    if (!sizeResult.valid) {
        return { skip: true, markCompleted: sizeResult.markCompleted };
    }

    return { skip: false, data: docData, markCompleted: true };
}

function incrementProgress(progressBar: ProgressBarWrapper): void {
    progressBar.increment();
}

async function commitBatchWithRetry(
    destBatch: WriteBatch,
    batchDocIds: string[],
    ctx: TransferContext,
    collectionPath: string
): Promise<void> {
    const { config, output, stateSaver, stats, rateLimiter } = ctx;

    if (rateLimiter) {
        await rateLimiter.acquire(batchDocIds.length);
    }

    await withRetry(() => destBatch.commit(), {
        retries: config.retries,
        onRetry: (attempt, max, err, delay) => {
            output.logError(`Retry commit ${attempt}/${max}`, { error: err.message, delay });
        },
    });

    if (stateSaver && batchDocIds.length > 0) {
        stateSaver.markBatchCompleted(collectionPath, batchDocIds, stats);
    }
}

function addDocToBatch(
    destBatch: FirebaseFirestore.WriteBatch,
    destDb: Firestore,
    destCollectionPath: string,
    destDocId: string,
    data: Record<string, unknown>,
    merge: boolean
): void {
    const destDocRef = destDb.collection(destCollectionPath).doc(destDocId);
    if (merge) {
        destBatch.set(destDocRef, data, { merge: true });
    } else {
        destBatch.set(destDocRef, data);
    }
}

async function processDocInBatch(
    doc: QueryDocumentSnapshot,
    ctx: TransferContext,
    collectionPath: string,
    destCollectionPath: string,
    destBatch: FirebaseFirestore.WriteBatch,
    batchDocIds: string[],
    depth: number
): Promise<void> {
    const { destDb, config, stats, output, progressBar } = ctx;
    const result = processDocument(doc, ctx, collectionPath, destCollectionPath);
    incrementProgress(progressBar);

    if (result.skip) {
        if (result.markCompleted) batchDocIds.push(doc.id);
        return;
    }

    const destDocId = getDestDocId(doc.id, config.idPrefix, config.idSuffix);

    if (!config.dryRun) {
        addDocToBatch(destBatch, destDb, destCollectionPath, destDocId, result.data!, config.merge);
    }

    batchDocIds.push(doc.id);
    stats.documentsTransferred++;

    output.logInfo('Transferred document', {
        source: collectionPath,
        dest: destCollectionPath,
        sourceDocId: doc.id,
        destDocId,
    });

    if (config.includeSubcollections) {
        await processSubcollections(ctx, doc, collectionPath, depth);
    }
}

async function processBatch(
    batch: QueryDocumentSnapshot[],
    ctx: TransferContext,
    collectionPath: string,
    destCollectionPath: string,
    depth: number
): Promise<string[]> {
    const destBatch = ctx.destDb.batch();
    const batchDocIds: string[] = [];

    for (const doc of batch) {
        await processDocInBatch(doc, ctx, collectionPath, destCollectionPath, destBatch, batchDocIds, depth);
    }

    if (!ctx.config.dryRun && batch.length > 0) {
        await commitBatchWithRetry(destBatch, batchDocIds, ctx, collectionPath);
    }

    return batchDocIds;
}

export async function transferCollection(
    ctx: TransferContext,
    collectionPath: string,
    depth: number = 0
): Promise<void> {
    const { sourceDb, config, stats, output } = ctx;
    const destCollectionPath = getDestCollectionPath(collectionPath, config.renameCollection);

    const query = buildTransferQuery(sourceDb, collectionPath, config, depth);

    const snapshot = await withRetry(() => query.get(), {
        retries: config.retries,
        onRetry: (attempt, max, err, delay) => {
            output.logError(`Retry ${attempt}/${max} for ${collectionPath}`, { error: err.message, delay });
        },
    });

    if (snapshot.empty) return;

    stats.collectionsProcessed++;
    output.logInfo(`Processing collection: ${collectionPath}`, { documents: snapshot.size });

    for (let i = 0; i < snapshot.docs.length; i += config.batchSize) {
        const batch = snapshot.docs.slice(i, i + config.batchSize);
        await processBatch(batch, ctx, collectionPath, destCollectionPath, depth);
    }
}
