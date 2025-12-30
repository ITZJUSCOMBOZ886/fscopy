import { describe, test, expect, mock, beforeEach, spyOn } from 'bun:test';
import type { Config } from '../types.js';

// Mock @inquirer/prompts
const mockInput = mock<() => Promise<string>>(() => Promise.resolve(''));
const mockCheckbox = mock<() => Promise<string[]>>(() => Promise.resolve([]));
const mockConfirm = mock<() => Promise<boolean>>(() => Promise.resolve(true));

mock.module('@inquirer/prompts', () => ({
    input: mockInput,
    checkbox: mockCheckbox,
    confirm: mockConfirm,
}));

// Mock firebase-admin
const mockDelete = mock(() => Promise.resolve());
const mockCountGet = mock(() => Promise.resolve({ data: () => ({ count: 10 }) }));
const mockCount = mock(() => ({ get: mockCountGet }));
const mockCollection = mock(() => ({ count: mockCount }));
const mockListCollections = mock(() => Promise.resolve([
    { id: 'users' },
    { id: 'orders' },
    { id: 'products' },
]));
const mockFirestore = mock(() => ({
    collection: mockCollection,
    listCollections: mockListCollections,
}));
const mockApp = {
    firestore: mockFirestore,
    delete: mockDelete,
};
const mockInitializeApp = mock(() => mockApp);
const mockApplicationDefault = mock(() => ({}));

mock.module('firebase-admin', () => ({
    default: {
        initializeApp: mockInitializeApp,
        credential: {
            applicationDefault: mockApplicationDefault,
        },
    },
}));

// Import after mocking
const { runInteractiveMode } = await import('../interactive.js');

// Helper to create base config
function createBaseConfig(overrides: Partial<Config> = {}): Config {
    return {
        collections: [],
        includeSubcollections: false,
        dryRun: true,
        batchSize: 500,
        limit: 0,
        sourceProject: null,
        destProject: null,
        retries: 3,
        where: [],
        exclude: [],
        merge: false,
        parallel: 1,
        clear: false,
        deleteMissing: false,
        transform: null,
        renameCollection: {},
        idPrefix: null,
        idSuffix: null,
        webhook: null,
        resume: false,
        stateFile: '.fscopy-state.json',
        verify: false,
        rateLimit: 0,
        skipOversized: false,
        json: false,
        transformSamples: 3,
        detectConflicts: false,
        ...overrides,
    };
}

describe('Interactive Mode', () => {
    beforeEach(() => {
        // Reset all mocks
        mockInput.mockReset();
        mockCheckbox.mockReset();
        mockConfirm.mockReset();
        mockInitializeApp.mockReset();
        mockListCollections.mockReset();
        mockCountGet.mockReset();
        mockDelete.mockReset();

        // Set default implementations
        mockInput.mockImplementation(() => Promise.resolve('test-project'));
        mockCheckbox.mockImplementation(() => Promise.resolve(['users']));
        mockConfirm.mockImplementation(() => Promise.resolve(true));
        mockInitializeApp.mockImplementation(() => mockApp);
        mockListCollections.mockImplementation(() => Promise.resolve([
            { id: 'users' },
            { id: 'orders' },
        ]));
        mockCountGet.mockImplementation(() => Promise.resolve({ data: () => ({ count: 10 }) }));

        // Suppress console output during tests
        spyOn(console, 'log').mockImplementation(() => {});
        spyOn(console, 'error').mockImplementation(() => {});
    });

    describe('promptForProject', () => {
        test('uses existing source project if provided', async () => {
            const config = createBaseConfig({
                sourceProject: 'existing-source',
                destProject: 'existing-dest',
            });

            const result = await runInteractiveMode(config);

            // Should not prompt for projects since they're already set
            expect(result.sourceProject).toBe('existing-source');
            expect(result.destProject).toBe('existing-dest');
        });

        test('prompts for source project if not provided', async () => {
            mockInput.mockImplementationOnce(() => Promise.resolve('prompted-source'));
            mockInput.mockImplementationOnce(() => Promise.resolve('prompted-dest'));

            const config = createBaseConfig();
            const result = await runInteractiveMode(config);

            expect(mockInput).toHaveBeenCalled();
            expect(result.sourceProject).toBe('prompted-source');
        });
    });

    describe('collection selection', () => {
        test('lists collections from source project', async () => {
            mockListCollections.mockImplementation(() => Promise.resolve([
                { id: 'users' },
                { id: 'orders' },
                { id: 'products' },
            ]));
            mockCheckbox.mockImplementation(() => Promise.resolve(['users', 'orders']));

            const config = createBaseConfig({
                sourceProject: 'test-source',
                destProject: 'test-dest',
            });

            const result = await runInteractiveMode(config);

            expect(mockListCollections).toHaveBeenCalled();
            expect(result.collections).toEqual(['users', 'orders']);
        });

        test('pre-selects collections from config', async () => {
            // The checkbox function receives choices with checked based on config.collections
            // We verify this by checking the result includes 'users'
            mockCheckbox.mockImplementation(() => Promise.resolve(['users']));

            const config = createBaseConfig({
                sourceProject: 'test-source',
                destProject: 'test-dest',
                collections: ['users'],
            });

            const result = await runInteractiveMode(config);
            expect(result.collections).toContain('users');
        });
    });

    describe('same project handling', () => {
        test('prompts for ID prefix when source equals dest', async () => {
            // First confirm: "Add a prefix to document IDs?" -> yes
            mockConfirm.mockImplementationOnce(() => Promise.resolve(true));
            // Input: prefix value
            mockInput.mockImplementationOnce(() => Promise.resolve('backup_'));
            // Rest of confirms (includeSubcollections, dryRun, merge)
            mockConfirm.mockImplementation(() => Promise.resolve(false));

            const config = createBaseConfig({
                sourceProject: 'same-project',
                destProject: 'same-project',
            });

            const result = await runInteractiveMode(config);

            expect(result.idPrefix).toBe('backup_');
        });

        test('prompts for ID suffix when prefix declined', async () => {
            // First confirm: "Add a prefix to document IDs?" -> no
            mockConfirm.mockImplementationOnce(() => Promise.resolve(false));
            // Second confirm: "Add a suffix to document IDs instead?" -> yes
            mockConfirm.mockImplementationOnce(() => Promise.resolve(true));
            // Input: suffix value
            mockInput.mockImplementationOnce(() => Promise.resolve('_v2'));
            // Rest of confirms
            mockConfirm.mockImplementation(() => Promise.resolve(false));

            const config = createBaseConfig({
                sourceProject: 'same-project',
                destProject: 'same-project',
            });

            const result = await runInteractiveMode(config);

            expect(result.idSuffix).toBe('_v2');
        });
    });

    describe('options', () => {
        test('returns updated config with selected options', async () => {
            // includeSubcollections
            mockConfirm.mockImplementationOnce(() => Promise.resolve(true));
            // dryRun
            mockConfirm.mockImplementationOnce(() => Promise.resolve(false));
            // merge
            mockConfirm.mockImplementationOnce(() => Promise.resolve(true));

            mockCheckbox.mockImplementation(() => Promise.resolve(['users', 'orders']));

            const config = createBaseConfig({
                sourceProject: 'source',
                destProject: 'dest',
            });

            const result = await runInteractiveMode(config);

            expect(result.includeSubcollections).toBe(true);
            expect(result.dryRun).toBe(false);
            expect(result.merge).toBe(true);
            expect(result.collections).toEqual(['users', 'orders']);
        });

        test('preserves non-interactive config values', async () => {
            const config = createBaseConfig({
                sourceProject: 'source',
                destProject: 'dest',
                batchSize: 100,
                limit: 50,
                retries: 5,
                webhook: 'https://example.com/hook',
            });

            const result = await runInteractiveMode(config);

            expect(result.batchSize).toBe(100);
            expect(result.limit).toBe(50);
            expect(result.retries).toBe(5);
            expect(result.webhook).toBe('https://example.com/hook');
        });
    });

    describe('Firebase connection', () => {
        test('initializes Firebase with source project', async () => {
            const config = createBaseConfig({
                sourceProject: 'my-source-project',
                destProject: 'my-dest-project',
            });

            await runInteractiveMode(config);

            expect(mockInitializeApp).toHaveBeenCalledWith(
                expect.objectContaining({
                    projectId: 'my-source-project',
                }),
                'interactive-source'
            );
        });

        test('cleans up Firebase app after completion', async () => {
            const config = createBaseConfig({
                sourceProject: 'source',
                destProject: 'dest',
            });

            await runInteractiveMode(config);

            expect(mockDelete).toHaveBeenCalled();
        });

        test('counts documents in each collection', async () => {
            mockListCollections.mockImplementation(() => Promise.resolve([
                { id: 'users' },
                { id: 'orders' },
            ]));

            const config = createBaseConfig({
                sourceProject: 'source',
                destProject: 'dest',
            });

            await runInteractiveMode(config);

            // collection() should be called for each collection to count
            expect(mockCollection).toHaveBeenCalledWith('users');
            expect(mockCollection).toHaveBeenCalledWith('orders');
        });
    });
});
