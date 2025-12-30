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
export function estimateDocumentSize(data: Record<string, unknown>, docPath?: string): number {
    let size = 0;

    // Document name (path) contributes to size
    if (docPath) {
        size += docPath.length + 1;
    }

    size += estimateValueSize(data);

    return size;
}

function isFirestoreTimestamp(value: object): boolean {
    return '_seconds' in value && '_nanoseconds' in value;
}

function isGeoPoint(value: object): boolean {
    return '_latitude' in value && '_longitude' in value;
}

function isDocumentReference(value: object): boolean {
    return '_path' in value && typeof (value as { _path: unknown })._path === 'object';
}

function getDocRefSize(value: object): number {
    const pathObj = (value as { _path: { segments?: string[] } })._path;
    if (pathObj.segments) {
        return pathObj.segments.join('/').length + 1;
    }
    return 16; // Approximate
}

function estimateArraySize(arr: unknown[]): number {
    let size = 0;
    for (const item of arr) {
        size += estimateValueSize(item);
    }
    return size;
}

function estimateObjectSize(obj: object): number {
    let size = 0;
    for (const [key, val] of Object.entries(obj)) {
        size += key.length + 1; // Key size
        size += estimateValueSize(val); // Value size
    }
    return size;
}

function estimateValueSize(value: unknown): number {
    if (value === null || value === undefined) return 1;
    if (typeof value === 'boolean') return 1;
    if (typeof value === 'number') return 8;
    if (typeof value === 'string') return Buffer.byteLength(value, 'utf8') + 1;
    if (value instanceof Date) return 8;

    if (typeof value === 'object') {
        if (isFirestoreTimestamp(value)) return 8;
        if (isGeoPoint(value)) return 16;
        if (isDocumentReference(value)) return getDocRefSize(value);
        if (Array.isArray(value)) return estimateArraySize(value);
        return estimateObjectSize(value);
    }

    return 8; // Unknown type
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
