import type { Firestore } from 'firebase-admin/firestore';
import type { Config } from '../types.js';
import type { Logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { matchesExcludePattern } from '../utils/patterns.js';
import { getSubcollections, getDestCollectionPath } from './helpers.js';

export async function clearCollection(
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

export async function deleteOrphanDocuments(
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
                    logger.error(
                        `Retry delete orphans ${attempt}/${max} for ${destCollectionPath}`,
                        {
                            error: err.message,
                            delay,
                        }
                    );
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
                deletedCount += await deleteOrphanDocuments(
                    sourceDb,
                    destDb,
                    subPath,
                    config,
                    logger
                );
            }
        }
    }

    return deletedCount;
}
