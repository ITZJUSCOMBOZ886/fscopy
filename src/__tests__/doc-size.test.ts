import { describe, test, expect } from 'bun:test';
import { estimateDocumentSize, formatBytes, FIRESTORE_MAX_DOC_SIZE } from '../utils/doc-size.js';

describe('FIRESTORE_MAX_DOC_SIZE', () => {
    test('is 1MB', () => {
        expect(FIRESTORE_MAX_DOC_SIZE).toBe(1024 * 1024);
    });
});

describe('estimateDocumentSize', () => {
    test('estimates empty object', () => {
        const size = estimateDocumentSize({});
        expect(size).toBe(0);
    });

    test('estimates string fields', () => {
        const size = estimateDocumentSize({ name: 'hello' });
        // 'name' = 4 + 1, 'hello' = 5 + 1 = 11
        expect(size).toBe(11);
    });

    test('estimates number fields', () => {
        const size = estimateDocumentSize({ count: 42 });
        // 'count' = 5 + 1, number = 8 = 14
        expect(size).toBe(14);
    });

    test('estimates boolean fields', () => {
        const size = estimateDocumentSize({ active: true });
        // 'active' = 6 + 1, boolean = 1 = 8
        expect(size).toBe(8);
    });

    test('estimates null fields', () => {
        const size = estimateDocumentSize({ empty: null });
        // 'empty' = 5 + 1, null = 1 = 7
        expect(size).toBe(7);
    });

    test('estimates nested objects', () => {
        const size = estimateDocumentSize({
            user: {
                name: 'John',
            },
        });
        // 'user' = 4 + 1, 'name' = 4 + 1, 'John' = 4 + 1 = 15
        expect(size).toBe(15);
    });

    test('estimates arrays', () => {
        const size = estimateDocumentSize({
            tags: ['a', 'b'],
        });
        // 'tags' = 4 + 1, 'a' = 1 + 1, 'b' = 1 + 1 = 9
        expect(size).toBe(9);
    });

    test('includes document path in size', () => {
        const sizeWithPath = estimateDocumentSize({ a: 1 }, 'users/123');
        const sizeWithoutPath = estimateDocumentSize({ a: 1 });
        // path adds 'users/123' = 9 + 1 = 10
        expect(sizeWithPath - sizeWithoutPath).toBe(10);
    });

    test('estimates UTF-8 strings correctly', () => {
        const size = estimateDocumentSize({ emoji: '🔥' });
        // 'emoji' = 5 + 1, '🔥' = 4 bytes (UTF-8) + 1 = 11
        expect(size).toBe(11);
    });

    test('estimates complex document', () => {
        const doc = {
            name: 'Test Document',
            count: 100,
            active: true,
            metadata: {
                created: 'date',
                tags: ['tag1', 'tag2'],
            },
        };
        const size = estimateDocumentSize(doc);
        expect(size).toBeGreaterThan(0);
        expect(size).toBeLessThan(1000);
    });
});

describe('formatBytes', () => {
    test('formats bytes', () => {
        expect(formatBytes(500)).toBe('500 B');
    });

    test('formats kilobytes', () => {
        expect(formatBytes(1024)).toBe('1.0 KB');
        expect(formatBytes(1536)).toBe('1.5 KB');
    });

    test('formats megabytes', () => {
        expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
        expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.50 MB');
    });
});
