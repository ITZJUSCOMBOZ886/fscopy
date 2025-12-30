import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    loadTransferState,
    saveTransferState,
    deleteTransferState,
    createInitialState,
    validateStateForResume,
    isDocCompleted,
    markDocCompleted,
    STATE_VERSION,
} from '../state/index.js';
import type { Config, TransferState } from '../types.js';

describe('State Management', () => {
    let tempDir: string;
    let stateFile: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fscopy-test-'));
        stateFile = path.join(tempDir, '.fscopy-state.json');
    });

    afterEach(() => {
        // Clean up temp directory
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('loadTransferState', () => {
        test('returns null for non-existent file', () => {
            const result = loadTransferState(stateFile);
            expect(result).toBeNull();
        });

        test('loads valid state file', () => {
            const state: TransferState = {
                version: STATE_VERSION,
                sourceProject: 'source',
                destProject: 'dest',
                collections: ['users'],
                startedAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
                completedDocs: { users: ['doc1', 'doc2'] },
                stats: { collectionsProcessed: 1, documentsTransferred: 2, documentsDeleted: 0, errors: 0 },
            };
            fs.writeFileSync(stateFile, JSON.stringify(state));

            const result = loadTransferState(stateFile);
            expect(result).not.toBeNull();
            expect(result!.sourceProject).toBe('source');
            expect(result!.completedDocs.users).toEqual(['doc1', 'doc2']);
        });

        test('returns null for version mismatch', () => {
            const state = {
                version: 999,
                sourceProject: 'source',
                destProject: 'dest',
                collections: [],
                startedAt: '',
                updatedAt: '',
                completedDocs: {},
                stats: { collectionsProcessed: 0, documentsTransferred: 0, documentsDeleted: 0, errors: 0 },
            };
            fs.writeFileSync(stateFile, JSON.stringify(state));

            const result = loadTransferState(stateFile);
            expect(result).toBeNull();
        });

        test('returns null for invalid JSON', () => {
            fs.writeFileSync(stateFile, 'invalid json');
            const result = loadTransferState(stateFile);
            expect(result).toBeNull();
        });
    });

    describe('saveTransferState', () => {
        test('saves state to file', () => {
            const state: TransferState = {
                version: STATE_VERSION,
                sourceProject: 'source',
                destProject: 'dest',
                collections: ['users'],
                startedAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
                completedDocs: {},
                stats: { collectionsProcessed: 0, documentsTransferred: 0, documentsDeleted: 0, errors: 0 },
            };

            saveTransferState(stateFile, state);

            expect(fs.existsSync(stateFile)).toBe(true);
            const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
            expect(loaded.sourceProject).toBe('source');
        });

        test('updates updatedAt timestamp', () => {
            const state: TransferState = {
                version: STATE_VERSION,
                sourceProject: 'source',
                destProject: 'dest',
                collections: [],
                startedAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
                completedDocs: {},
                stats: { collectionsProcessed: 0, documentsTransferred: 0, documentsDeleted: 0, errors: 0 },
            };

            saveTransferState(stateFile, state);

            const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
            expect(loaded.updatedAt).not.toBe('2024-01-01T00:00:00.000Z');
        });

        test('cleans up temp file on success', () => {
            const state: TransferState = {
                version: STATE_VERSION,
                sourceProject: 'source',
                destProject: 'dest',
                collections: [],
                startedAt: '',
                updatedAt: '',
                completedDocs: {},
                stats: { collectionsProcessed: 0, documentsTransferred: 0, documentsDeleted: 0, errors: 0 },
            };

            saveTransferState(stateFile, state);

            expect(fs.existsSync(`${stateFile}.tmp`)).toBe(false);
        });
    });

    describe('deleteTransferState', () => {
        test('deletes existing state file', () => {
            fs.writeFileSync(stateFile, '{}');
            expect(fs.existsSync(stateFile)).toBe(true);

            deleteTransferState(stateFile);

            expect(fs.existsSync(stateFile)).toBe(false);
        });

        test('does nothing for non-existent file', () => {
            expect(() => deleteTransferState(stateFile)).not.toThrow();
        });
    });

    describe('createInitialState', () => {
        test('creates state with correct structure', () => {
            const config = {
                sourceProject: 'source-proj',
                destProject: 'dest-proj',
                collections: ['users', 'orders'],
            } as Config;

            const state = createInitialState(config);

            expect(state.version).toBe(STATE_VERSION);
            expect(state.sourceProject).toBe('source-proj');
            expect(state.destProject).toBe('dest-proj');
            expect(state.collections).toEqual(['users', 'orders']);
            expect(state.completedDocs).toEqual({});
            expect(state.stats.collectionsProcessed).toBe(0);
            expect(state.stats.documentsTransferred).toBe(0);
        });

        test('sets timestamps', () => {
            const config = { sourceProject: 'a', destProject: 'b', collections: [] } as unknown as Config;
            const before = new Date().toISOString();

            const state = createInitialState(config);

            const after = new Date().toISOString();
            expect(state.startedAt >= before).toBe(true);
            expect(state.startedAt <= after).toBe(true);
        });
    });

    describe('validateStateForResume', () => {
        const baseConfig = {
            sourceProject: 'source',
            destProject: 'dest',
            collections: ['users', 'orders'],
        } as Config;

        const baseState: TransferState = {
            version: STATE_VERSION,
            sourceProject: 'source',
            destProject: 'dest',
            collections: ['users'],
            startedAt: '',
            updatedAt: '',
            completedDocs: {},
            stats: { collectionsProcessed: 0, documentsTransferred: 0, documentsDeleted: 0, errors: 0 },
        };

        test('returns no errors for compatible state', () => {
            const errors = validateStateForResume(baseState, baseConfig);
            expect(errors).toEqual([]);
        });

        test('returns error for source project mismatch', () => {
            const state = { ...baseState, sourceProject: 'different' };
            const errors = validateStateForResume(state, baseConfig);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('Source project mismatch');
        });

        test('returns error for dest project mismatch', () => {
            const state = { ...baseState, destProject: 'different' };
            const errors = validateStateForResume(state, baseConfig);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('Destination project mismatch');
        });

        test('returns error for collection not in config', () => {
            const state = { ...baseState, collections: ['users', 'unknown'] };
            const errors = validateStateForResume(state, baseConfig);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('unknown');
        });

        test('returns multiple errors', () => {
            const state = { ...baseState, sourceProject: 'x', destProject: 'y' };
            const errors = validateStateForResume(state, baseConfig);
            expect(errors).toHaveLength(2);
        });
    });

    describe('isDocCompleted', () => {
        test('returns false for empty completedDocs', () => {
            const state: TransferState = {
                version: STATE_VERSION,
                sourceProject: '',
                destProject: '',
                collections: [],
                startedAt: '',
                updatedAt: '',
                completedDocs: {},
                stats: { collectionsProcessed: 0, documentsTransferred: 0, documentsDeleted: 0, errors: 0 },
            };

            expect(isDocCompleted(state, 'users', 'doc1')).toBe(false);
        });

        test('returns false for doc not in collection', () => {
            const state: TransferState = {
                version: STATE_VERSION,
                sourceProject: '',
                destProject: '',
                collections: [],
                startedAt: '',
                updatedAt: '',
                completedDocs: { users: ['doc1', 'doc2'] },
                stats: { collectionsProcessed: 0, documentsTransferred: 0, documentsDeleted: 0, errors: 0 },
            };

            expect(isDocCompleted(state, 'users', 'doc3')).toBe(false);
        });

        test('returns true for completed doc', () => {
            const state: TransferState = {
                version: STATE_VERSION,
                sourceProject: '',
                destProject: '',
                collections: [],
                startedAt: '',
                updatedAt: '',
                completedDocs: { users: ['doc1', 'doc2'] },
                stats: { collectionsProcessed: 0, documentsTransferred: 0, documentsDeleted: 0, errors: 0 },
            };

            expect(isDocCompleted(state, 'users', 'doc1')).toBe(true);
        });
    });

    describe('markDocCompleted', () => {
        test('creates collection array if not exists', () => {
            const state: TransferState = {
                version: STATE_VERSION,
                sourceProject: '',
                destProject: '',
                collections: [],
                startedAt: '',
                updatedAt: '',
                completedDocs: {},
                stats: { collectionsProcessed: 0, documentsTransferred: 0, documentsDeleted: 0, errors: 0 },
            };

            markDocCompleted(state, 'users', 'doc1');

            expect(state.completedDocs.users).toEqual(['doc1']);
        });

        test('appends to existing collection array', () => {
            const state: TransferState = {
                version: STATE_VERSION,
                sourceProject: '',
                destProject: '',
                collections: [],
                startedAt: '',
                updatedAt: '',
                completedDocs: { users: ['doc1'] },
                stats: { collectionsProcessed: 0, documentsTransferred: 0, documentsDeleted: 0, errors: 0 },
            };

            markDocCompleted(state, 'users', 'doc2');

            expect(state.completedDocs.users).toEqual(['doc1', 'doc2']);
        });
    });
});
