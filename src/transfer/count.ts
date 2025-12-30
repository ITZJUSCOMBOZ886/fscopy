import type { Firestore } from 'firebase-admin/firestore';
import type { Config } from '../types.js';
import { matchesExcludePattern } from '../utils/patterns.js';
import { getSubcollections } from './helpers.js';

export interface CountProgress {
    onCollection?: (path: string, count: number) => void;
    onSubcollection?: (path: string) => void;
}

export async function countDocuments(
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
