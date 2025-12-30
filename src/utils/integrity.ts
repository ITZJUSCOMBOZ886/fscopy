import { createHash } from 'node:crypto';

/**
 * Compute a SHA-256 hash of document data.
 * The data is serialized to a deterministic JSON string before hashing.
 */
export function hashDocumentData(data: Record<string, unknown>): string {
    const serialized = serializeForHash(data);
    return createHash('sha256').update(serialized).digest('hex');
}

/**
 * Serialize document data to a deterministic JSON string.
 * Keys are sorted alphabetically at each level for consistency.
 */
function serializeForHash(value: unknown): string {
    if (value === null || value === undefined) {
        return 'null';
    }

    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
        return JSON.stringify(value);
    }

    // Handle Date objects
    if (value instanceof Date) {
        return JSON.stringify(value.toISOString());
    }

    // Handle Firestore Timestamp
    if (isFirestoreTimestamp(value)) {
        return JSON.stringify({ _seconds: value.seconds, _nanoseconds: value.nanoseconds });
    }

    // Handle Firestore GeoPoint
    if (isFirestoreGeoPoint(value)) {
        return JSON.stringify({ _latitude: value.latitude, _longitude: value.longitude });
    }

    // Handle Firestore DocumentReference
    if (isFirestoreDocumentReference(value)) {
        return JSON.stringify({ _path: value.path });
    }

    // Handle arrays
    if (Array.isArray(value)) {
        const elements = value.map((item) => serializeForHash(item));
        return `[${elements.join(',')}]`;
    }

    // Handle objects - sort keys for deterministic output
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const sortedKeys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
        const pairs = sortedKeys.map((key) => `${JSON.stringify(key)}:${serializeForHash(obj[key])}`);
        return `{${pairs.join(',')}}`;
    }

    // Fallback for unknown types - should not reach here normally
    return '"[unknown]"';
}

/**
 * Compare two document hashes.
 */
export function compareHashes(sourceHash: string, destHash: string): boolean {
    return sourceHash === destHash;
}

// Type guards for Firestore types

interface FirestoreTimestamp {
    seconds: number;
    nanoseconds: number;
    toDate?: () => Date;
}

interface FirestoreGeoPoint {
    latitude: number;
    longitude: number;
}

interface FirestoreDocumentReference {
    path: string;
    id: string;
}

function isFirestoreTimestamp(value: unknown): value is FirestoreTimestamp {
    return (
        typeof value === 'object' &&
        value !== null &&
        'seconds' in value &&
        'nanoseconds' in value &&
        typeof (value as FirestoreTimestamp).seconds === 'number' &&
        typeof (value as FirestoreTimestamp).nanoseconds === 'number'
    );
}

function isFirestoreGeoPoint(value: unknown): value is FirestoreGeoPoint {
    return (
        typeof value === 'object' &&
        value !== null &&
        'latitude' in value &&
        'longitude' in value &&
        typeof (value as FirestoreGeoPoint).latitude === 'number' &&
        typeof (value as FirestoreGeoPoint).longitude === 'number' &&
        !('seconds' in value)
    );
}

function isFirestoreDocumentReference(value: unknown): value is FirestoreDocumentReference {
    return (
        typeof value === 'object' &&
        value !== null &&
        'path' in value &&
        'id' in value &&
        typeof (value as FirestoreDocumentReference).path === 'string' &&
        typeof (value as FirestoreDocumentReference).id === 'string'
    );
}
