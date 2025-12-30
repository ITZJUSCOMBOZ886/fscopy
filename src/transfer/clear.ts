import type { Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { Config } from '../types.js';
import type { Output } from '../utils/output.js';
import { withRetry } from '../utils/retry.js';
import { matchesExcludePattern } from '../utils/patterns.js';
import { getSubcollections, getDestCollectionPath } from './helpers.js';

async function clearDocSubcollections(
    db: Firestore,
    doc: QueryDocumentSnapshot,
    collectionPath: string,
    config: Config,
    output: Output
): Promise<number> {
    let deletedCount = 0;
    const subcollections = await getSubcollections(doc.ref);

    for (const subId of subcollections) {
        if (matchesExcludePattern(subId, config.exclude)) continue;

        const subPath = `${collectionPath}/${doc.id}/${subId}`;
        deletedCount += await clearCollection(db, subPath, config, output, true);
    }

    return deletedCount;
}

async function deleteBatch(
    db: Firestore,
    batch: QueryDocumentSnapshot[],
    collectionPath: string,
    config: Config,
    output: Output
): Promise<number> {
    const writeBatch = db.batch();

    for (const doc of batch) {
        writeBatch.delete(doc.ref);
    }

    if (!config.dryRun) {
        await withRetry(() => writeBatch.commit(), {
            retries: config.retries,
            onRetry: (attempt, max, err, delay) => {
                output.logError(`Retry delete ${attempt}/${max} for ${collectionPath}`, {
                    error: err.message,
                    delay,
                });
            },
        });
    }

    output.logInfo(`Deleted ${batch.length} documents from ${collectionPath}`);
    return batch.length;
}

export async function clearCollection(
    db: Firestore,
    collectionPath: string,
    config: Config,
    output: Output,
    includeSubcollections: boolean
): Promise<number> {
    const snapshot = await db.collection(collectionPath).get();
    if (snapshot.empty) return 0;

    let deletedCount = 0;

    // Delete subcollections first if enabled
    if (includeSubcollections) {
        for (const doc of snapshot.docs) {
            deletedCount += await clearDocSubcollections(db, doc, collectionPath, config, output);
        }
    }

    // Delete documents in batches
    for (let i = 0; i < snapshot.docs.length; i += config.batchSize) {
        const batch = snapshot.docs.slice(i, i + config.batchSize);
        deletedCount += await deleteBatch(db, batch, collectionPath, config, output);
    }

    return deletedCount;
}

async function clearOrphanSubcollections(
    destDb: Firestore,
    doc: QueryDocumentSnapshot,
    destCollectionPath: string,
    config: Config,
    output: Output
): Promise<number> {
    let deletedCount = 0;
    const subcollections = await getSubcollections(doc.ref);

    for (const subId of subcollections) {
        if (matchesExcludePattern(subId, config.exclude)) continue;

        const subPath = `${destCollectionPath}/${doc.id}/${subId}`;
        deletedCount += await clearCollection(destDb, subPath, config, output, true);
    }

    return deletedCount;
}

async function deleteOrphanBatch(
    destDb: Firestore,
    batch: QueryDocumentSnapshot[],
    destCollectionPath: string,
    config: Config,
    output: Output
): Promise<number> {
    let deletedCount = 0;
    const writeBatch = destDb.batch();

    for (const doc of batch) {
        if (config.includeSubcollections) {
            deletedCount += await clearOrphanSubcollections(
                destDb,
                doc,
                destCollectionPath,
                config,
                output
            );
        }
        writeBatch.delete(doc.ref);
        deletedCount++;
    }

    if (!config.dryRun) {
        await withRetry(() => writeBatch.commit(), {
            retries: config.retries,
            onRetry: (attempt, max, err, delay) => {
                output.logError(
                    `Retry delete orphans ${attempt}/${max} for ${destCollectionPath}`,
                    {
                        error: err.message,
                        delay,
                    }
                );
            },
        });
    }

    output.logInfo(`Deleted ${batch.length} orphan documents from ${destCollectionPath}`);
    return deletedCount;
}

async function processSubcollectionOrphans(
    sourceDb: Firestore,
    destDb: Firestore,
    sourceSnapshot: FirebaseFirestore.QuerySnapshot,
    sourceCollectionPath: string,
    config: Config,
    output: Output
): Promise<number> {
    let deletedCount = 0;

    for (const sourceDoc of sourceSnapshot.docs) {
        const sourceSubcollections = await getSubcollections(sourceDoc.ref);
        for (const subId of sourceSubcollections) {
            if (matchesExcludePattern(subId, config.exclude)) continue;

            const subPath = `${sourceCollectionPath}/${sourceDoc.id}/${subId}`;
            deletedCount += await deleteOrphanDocuments(sourceDb, destDb, subPath, config, output);
        }
    }

    return deletedCount;
}

export async function deleteOrphanDocuments(
    sourceDb: Firestore,
    destDb: Firestore,
    sourceCollectionPath: string,
    config: Config,
    output: Output
): Promise<number> {
    const destCollectionPath = getDestCollectionPath(sourceCollectionPath, config.renameCollection);

    const sourceSnapshot = await sourceDb.collection(sourceCollectionPath).select().get();
    const sourceIds = new Set(sourceSnapshot.docs.map((doc) => doc.id));

    const destSnapshot = await destDb.collection(destCollectionPath).select().get();
    const orphanDocs = destSnapshot.docs.filter((doc) => !sourceIds.has(doc.id));

    let deletedCount = 0;

    if (orphanDocs.length > 0) {
        output.logInfo(`Found ${orphanDocs.length} orphan documents in ${destCollectionPath}`);

        for (let i = 0; i < orphanDocs.length; i += config.batchSize) {
            const batch = orphanDocs.slice(i, i + config.batchSize);
            deletedCount += await deleteOrphanBatch(
                destDb,
                batch,
                destCollectionPath,
                config,
                output
            );
        }
    }

    if (config.includeSubcollections) {
        deletedCount += await processSubcollectionOrphans(
            sourceDb,
            destDb,
            sourceSnapshot,
            sourceCollectionPath,
            config,
            output
        );
    }

    return deletedCount;
}
