import { describe, test, expect } from 'bun:test';
import { getDestCollectionPath, getDestDocId } from '../transfer/helpers.js';

describe('getDestCollectionPath', () => {
    test('returns same path when no mapping', () => {
        expect(getDestCollectionPath('users', {})).toBe('users');
    });

    test('returns same path when collection not in mapping', () => {
        expect(getDestCollectionPath('orders', { users: 'users_backup' })).toBe('orders');
    });

    test('renames root collection', () => {
        expect(getDestCollectionPath('users', { users: 'users_backup' })).toBe('users_backup');
    });

    test('renames root collection in nested path', () => {
        const result = getDestCollectionPath('users/123/orders', { users: 'users_v2' });
        expect(result).toBe('users_v2/123/orders');
    });

    test('handles deeply nested paths', () => {
        const result = getDestCollectionPath('users/123/posts/456/comments', { users: 'members' });
        expect(result).toBe('members/123/posts/456/comments');
    });

    test('only renames root collection', () => {
        // Should not rename 'users' subcollection in 'orders/123/users'
        const result = getDestCollectionPath('orders/123/users', { users: 'users_backup' });
        expect(result).toBe('orders/123/users');
    });

    test('handles multiple mappings', () => {
        const mapping = { users: 'users_v2', orders: 'orders_archive' };
        expect(getDestCollectionPath('users', mapping)).toBe('users_v2');
        expect(getDestCollectionPath('orders', mapping)).toBe('orders_archive');
        expect(getDestCollectionPath('products', mapping)).toBe('products');
    });
});

describe('getDestDocId', () => {
    test('returns original ID with no prefix or suffix', () => {
        expect(getDestDocId('doc123', null, null)).toBe('doc123');
    });

    test('adds prefix', () => {
        expect(getDestDocId('doc123', 'backup_', null)).toBe('backup_doc123');
    });

    test('adds suffix', () => {
        expect(getDestDocId('doc123', null, '_v2')).toBe('doc123_v2');
    });

    test('adds both prefix and suffix', () => {
        expect(getDestDocId('doc123', 'backup_', '_v2')).toBe('backup_doc123_v2');
    });

    test('handles empty string prefix', () => {
        expect(getDestDocId('doc123', '', null)).toBe('doc123');
    });

    test('handles empty string suffix', () => {
        expect(getDestDocId('doc123', null, '')).toBe('doc123');
    });

    test('handles special characters in ID', () => {
        expect(getDestDocId('user@email.com', 'pre_', '_suf')).toBe('pre_user@email.com_suf');
    });
});
