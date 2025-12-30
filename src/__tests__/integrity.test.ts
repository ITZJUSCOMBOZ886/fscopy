import { describe, test, expect } from 'bun:test';
import { hashDocumentData, compareHashes } from '../utils/integrity.js';

describe('Integrity Verification', () => {
    describe('hashDocumentData', () => {
        test('produces consistent hash for same data', () => {
            const data = { name: 'John', age: 30 };
            const hash1 = hashDocumentData(data);
            const hash2 = hashDocumentData(data);
            expect(hash1).toBe(hash2);
        });

        test('produces different hash for different data', () => {
            const data1 = { name: 'John', age: 30 };
            const data2 = { name: 'Jane', age: 25 };
            const hash1 = hashDocumentData(data1);
            const hash2 = hashDocumentData(data2);
            expect(hash1).not.toBe(hash2);
        });

        test('handles nested objects', () => {
            const data = {
                user: {
                    name: 'John',
                    address: {
                        city: 'Paris',
                        zip: '75001',
                    },
                },
            };
            const hash = hashDocumentData(data);
            expect(hash).toBeDefined();
            expect(hash.length).toBe(64); // SHA-256 hex length
        });

        test('handles arrays', () => {
            const data = {
                tags: ['a', 'b', 'c'],
                numbers: [1, 2, 3],
            };
            const hash = hashDocumentData(data);
            expect(hash).toBeDefined();
        });

        test('handles null values', () => {
            const data = { value: null };
            const hash = hashDocumentData(data);
            expect(hash).toBeDefined();
        });

        test('handles Date objects', () => {
            const data = { created: new Date('2024-01-01T00:00:00Z') };
            const hash = hashDocumentData(data);
            expect(hash).toBeDefined();
        });

        test('handles Firestore Timestamp-like objects', () => {
            const data = {
                timestamp: {
                    seconds: 1704067200,
                    nanoseconds: 0,
                },
            };
            const hash = hashDocumentData(data);
            expect(hash).toBeDefined();
        });

        test('handles Firestore GeoPoint-like objects', () => {
            const data = {
                location: {
                    latitude: 48.8566,
                    longitude: 2.3522,
                },
            };
            const hash = hashDocumentData(data);
            expect(hash).toBeDefined();
        });

        test('handles Firestore DocumentReference-like objects', () => {
            const data = {
                ref: {
                    path: 'users/123',
                    id: '123',
                },
            };
            const hash = hashDocumentData(data);
            expect(hash).toBeDefined();
        });

        test('produces same hash regardless of key order', () => {
            const data1 = { a: 1, b: 2, c: 3 };
            const data2 = { c: 3, a: 1, b: 2 };
            const hash1 = hashDocumentData(data1);
            const hash2 = hashDocumentData(data2);
            expect(hash1).toBe(hash2);
        });

        test('handles empty object', () => {
            const data = {};
            const hash = hashDocumentData(data);
            expect(hash).toBeDefined();
        });

        test('handles boolean values', () => {
            const data = { active: true, deleted: false };
            const hash = hashDocumentData(data);
            expect(hash).toBeDefined();
        });

        test('handles numeric values', () => {
            const data = { int: 42, float: 3.14, negative: -10 };
            const hash = hashDocumentData(data);
            expect(hash).toBeDefined();
        });

        test('handles unicode strings', () => {
            const data = { name: '日本語', emoji: '🔥' };
            const hash = hashDocumentData(data);
            expect(hash).toBeDefined();
        });
    });

    describe('compareHashes', () => {
        test('returns true for identical hashes', () => {
            const hash = 'abc123def456';
            expect(compareHashes(hash, hash)).toBe(true);
        });

        test('returns false for different hashes', () => {
            const hash1 = 'abc123';
            const hash2 = 'def456';
            expect(compareHashes(hash1, hash2)).toBe(false);
        });

        test('is case-sensitive', () => {
            const hash1 = 'ABC123';
            const hash2 = 'abc123';
            expect(compareHashes(hash1, hash2)).toBe(false);
        });
    });

    describe('end-to-end hash verification', () => {
        test('identical documents have matching hashes', () => {
            const sourceData = {
                name: 'Test User',
                email: 'test@example.com',
                metadata: {
                    created: { seconds: 1704067200, nanoseconds: 0 },
                    tags: ['user', 'test'],
                },
            };

            // Simulate dest data (same content)
            const destData = structuredClone(sourceData);

            const sourceHash = hashDocumentData(sourceData);
            const destHash = hashDocumentData(destData);

            expect(compareHashes(sourceHash, destHash)).toBe(true);
        });

        test('modified documents have different hashes', () => {
            const sourceData = {
                name: 'Test User',
                email: 'test@example.com',
            };

            // Simulate modified dest data
            const destData = {
                name: 'Test User',
                email: 'modified@example.com',
            };

            const sourceHash = hashDocumentData(sourceData);
            const destHash = hashDocumentData(destData);

            expect(compareHashes(sourceHash, destHash)).toBe(false);
        });

        test('data with added field has different hash', () => {
            const sourceData = { name: 'Test' };
            const destData = { name: 'Test', extra: 'field' };

            const sourceHash = hashDocumentData(sourceData);
            const destHash = hashDocumentData(destData);

            expect(compareHashes(sourceHash, destHash)).toBe(false);
        });

        test('data with removed field has different hash', () => {
            const sourceData = { name: 'Test', email: 'test@example.com' };
            const destData = { name: 'Test' };

            const sourceHash = hashDocumentData(sourceData);
            const destHash = hashDocumentData(destData);

            expect(compareHashes(sourceHash, destHash)).toBe(false);
        });
    });
});
