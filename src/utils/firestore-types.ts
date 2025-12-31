/**
 * Type guards for Firestore special types.
 *
 * Firestore SDK exposes these types with public properties:
 * - Timestamp: { seconds: number, nanoseconds: number, toDate(), toMillis() }
 * - GeoPoint: { latitude: number, longitude: number, isEqual() }
 * - DocumentReference: { path: string, id: string, parent, ... }
 *
 * Note: Internal properties like _seconds, _path may exist but are not guaranteed.
 * We use public API properties for reliability.
 */

export interface FirestoreTimestamp {
    seconds: number;
    nanoseconds: number;
    toDate?: () => Date;
    toMillis?: () => number;
}

export interface FirestoreGeoPoint {
    latitude: number;
    longitude: number;
    isEqual?: (other: unknown) => boolean;
}

export interface FirestoreDocumentReference {
    path: string;
    id: string;
}

/**
 * Check if value is a Firestore Timestamp.
 * Works with both SDK instances and plain objects with same shape.
 */
export function isTimestamp(value: unknown): value is FirestoreTimestamp {
    return (
        typeof value === 'object' &&
        value !== null &&
        'seconds' in value &&
        'nanoseconds' in value &&
        typeof (value as FirestoreTimestamp).seconds === 'number' &&
        typeof (value as FirestoreTimestamp).nanoseconds === 'number'
    );
}

/**
 * Check if value is a Firestore GeoPoint.
 * Excludes Timestamps which also have numeric properties.
 */
export function isGeoPoint(value: unknown): value is FirestoreGeoPoint {
    return (
        typeof value === 'object' &&
        value !== null &&
        'latitude' in value &&
        'longitude' in value &&
        typeof (value as FirestoreGeoPoint).latitude === 'number' &&
        typeof (value as FirestoreGeoPoint).longitude === 'number' &&
        !('seconds' in value) // Distinguish from Timestamp
    );
}

/**
 * Check if value is a Firestore DocumentReference.
 */
export function isDocumentReference(value: unknown): value is FirestoreDocumentReference {
    return (
        typeof value === 'object' &&
        value !== null &&
        'path' in value &&
        'id' in value &&
        typeof (value as FirestoreDocumentReference).path === 'string' &&
        typeof (value as FirestoreDocumentReference).id === 'string'
    );
}

/**
 * Get the path from a DocumentReference.
 * Handles both SDK instances and plain objects.
 */
export function getDocumentReferencePath(ref: FirestoreDocumentReference): string {
    return ref.path;
}
