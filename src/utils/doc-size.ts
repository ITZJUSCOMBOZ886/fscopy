/**
 * Firestore maximum document size in bytes (1 MiB)
 */
export const FIRESTORE_MAX_DOC_SIZE = 1024 * 1024;

/**
 * Estimate the size of a Firestore document in bytes.
 * This is an approximation - actual Firestore storage may differ slightly.
 *
 * Rules:
 * - Strings: UTF-8 encoded length + 1
 * - Numbers: 8 bytes
 * - Booleans: 1 byte
 * - Null: 1 byte
 * - Timestamps: 8 bytes
 * - Arrays: sum of element sizes
 * - Maps: sum of key + value sizes
 * - GeoPoints: 16 bytes
 * - References: document path length + 1
 */
export function estimateDocumentSize(
    data: Record<string, unknown>,
    docPath?: string
): number {
    let size = 0;

    // Document name (path) contributes to size
    if (docPath) {
        size += docPath.length + 1;
    }

    size += estimateValueSize(data);

    return size;
}

function estimateValueSize(value: unknown): number {
    if (value === null || value === undefined) {
        return 1;
    }

    if (typeof value === 'boolean') {
        return 1;
    }

    if (typeof value === 'number') {
        return 8;
    }

    if (typeof value === 'string') {
        // UTF-8 encoded length
        return Buffer.byteLength(value, 'utf8') + 1;
    }

    if (value instanceof Date) {
        return 8;
    }

    // Firestore Timestamp
    if (
        value &&
        typeof value === 'object' &&
        '_seconds' in value &&
        '_nanoseconds' in value
    ) {
        return 8;
    }

    // GeoPoint
    if (
        value &&
        typeof value === 'object' &&
        '_latitude' in value &&
        '_longitude' in value
    ) {
        return 16;
    }

    // DocumentReference
    if (
        value &&
        typeof value === 'object' &&
        '_path' in value &&
        typeof (value as { _path: unknown })._path === 'object'
    ) {
        const pathObj = (value as { _path: { segments?: string[] } })._path;
        if (pathObj.segments) {
            return pathObj.segments.join('/').length + 1;
        }
        return 16; // Approximate
    }

    // Array
    if (Array.isArray(value)) {
        let size = 0;
        for (const item of value) {
            size += estimateValueSize(item);
        }
        return size;
    }

    // Map/Object
    if (typeof value === 'object') {
        let size = 0;
        for (const [key, val] of Object.entries(value)) {
            // Key size (field name)
            size += key.length + 1;
            // Value size
            size += estimateValueSize(val);
        }
        return size;
    }

    // Unknown type - estimate as small value
    return 8;
}

/**
 * Format byte size to human-readable string
 */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
