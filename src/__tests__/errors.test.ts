import { describe, test, expect } from 'bun:test';
import { formatFirebaseError } from '../utils/errors.js';

describe('formatFirebaseError', () => {
    test('maps permission-denied error code', () => {
        const error = Object.assign(new Error('Permission denied'), { code: 'permission-denied' });
        const result = formatFirebaseError(error);

        expect(result.message).toBe('Permission denied');
        expect(result.suggestion).toContain('Firestore');
    });

    test('maps PERMISSION_DENIED error code', () => {
        const error = Object.assign(new Error('gRPC error'), { code: 'PERMISSION_DENIED' });
        const result = formatFirebaseError(error);

        expect(result.message).toBe('Permission denied');
    });

    test('maps resource-exhausted error code', () => {
        const error = Object.assign(new Error('Quota exceeded'), { code: 'resource-exhausted' });
        const result = formatFirebaseError(error);

        expect(result.message).toBe('Quota exceeded');
        expect(result.suggestion).toContain('batch-size');
    });

    test('maps unavailable error code', () => {
        const error = Object.assign(new Error('Service unavailable'), { code: 'unavailable' });
        const result = formatFirebaseError(error);

        expect(result.message).toBe('Service unavailable');
        expect(result.suggestion).toContain('internet');
    });

    test('maps not-found error code', () => {
        const error = Object.assign(new Error('Not found'), { code: 'not-found' });
        const result = formatFirebaseError(error);

        expect(result.message).toBe('Resource not found');
        expect(result.suggestion).toContain('project ID');
    });

    test('maps deadline-exceeded error code', () => {
        const error = Object.assign(new Error('Timeout'), { code: 'deadline-exceeded' });
        const result = formatFirebaseError(error);

        expect(result.message).toBe('Request timeout');
    });

    test('maps already-exists error code', () => {
        const error = Object.assign(new Error('Already exists'), { code: 'already-exists' });
        const result = formatFirebaseError(error);

        expect(result.message).toBe('Document already exists');
        expect(result.suggestion).toContain('--merge');
    });

    test('maps auth errors by code', () => {
        const error = Object.assign(new Error('Invalid'), { code: 'app/invalid-credential' });
        const result = formatFirebaseError(error);

        expect(result.message).toBe('Invalid application credentials');
        expect(result.suggestion).toContain('gcloud');
    });

    test('detects permission errors by message', () => {
        const error = new Error('Access denied to resource');
        const result = formatFirebaseError(error);

        expect(result.message).toBe('Permission denied');
    });

    test('detects credential errors by message', () => {
        const error = new Error('Could not load the default credentials');
        const result = formatFirebaseError(error);

        expect(result.message).toBe('Invalid application credentials');
    });

    test('detects network errors by message', () => {
        const error = new Error('Network connection failed');
        const result = formatFirebaseError(error);

        expect(result.message).toBe('Service unavailable');
    });

    test('detects quota errors by message', () => {
        const error = new Error('Rate limit exceeded');
        const result = formatFirebaseError(error);

        expect(result.message).toBe('Quota exceeded');
    });

    test('detects timeout errors by message', () => {
        const error = new Error('Request timeout after 30s');
        const result = formatFirebaseError(error);

        expect(result.message).toBe('Request timeout');
    });

    test('returns original message for unknown errors', () => {
        const error = new Error('Something unexpected happened');
        const result = formatFirebaseError(error);

        expect(result.message).toBe('Something unexpected happened');
        expect(result.suggestion).toBeUndefined();
    });
});
