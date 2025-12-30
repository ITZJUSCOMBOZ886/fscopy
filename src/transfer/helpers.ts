import type { DocumentReference } from 'firebase-admin/firestore';

export async function getSubcollections(docRef: DocumentReference): Promise<string[]> {
    const collections = await docRef.listCollections();
    return collections.map((col) => col.id);
}

export function getDestCollectionPath(
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

export function getDestDocId(
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
