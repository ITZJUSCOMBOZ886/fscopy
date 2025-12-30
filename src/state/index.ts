import fs from 'node:fs';
import type { Config, TransferState, Stats } from '../types.js';

export const STATE_VERSION = 1;

export interface StateSaverOptions {
    /** Save every N batches (default: 10) */
    batchInterval?: number;
    /** Save every N milliseconds (default: 5000) */
    timeInterval?: number;
}

const DEFAULT_BATCH_INTERVAL = 10;
const DEFAULT_TIME_INTERVAL = 5000;

/**
 * Throttled state saver to reduce I/O overhead.
 * Saves state every N batches OR after X milliseconds, whichever comes first.
 */
export class StateSaver {
    private lastSaveTime: number = Date.now();
    private batchesSinceLastSave: number = 0;
    private readonly batchInterval: number;
    private readonly timeInterval: number;
    private dirty: boolean = false;

    constructor(
        private readonly stateFile: string,
        private readonly state: TransferState,
        options: StateSaverOptions = {}
    ) {
        this.batchInterval = options.batchInterval ?? DEFAULT_BATCH_INTERVAL;
        this.timeInterval = options.timeInterval ?? DEFAULT_TIME_INTERVAL;
    }

    /**
     * Mark documents as completed and update stats.
     * Saves to disk if thresholds are met.
     */
    markBatchCompleted(collectionPath: string, docIds: string[], stats: Stats): void {
        for (const docId of docIds) {
            markDocCompleted(this.state, collectionPath, docId);
        }
        this.state.stats = { ...stats };
        this.dirty = true;
        this.batchesSinceLastSave++;

        if (this.shouldSave()) {
            this.save();
        }
    }

    /**
     * Check if we should save based on batch count or time elapsed.
     */
    private shouldSave(): boolean {
        if (this.batchesSinceLastSave >= this.batchInterval) {
            return true;
        }

        const elapsed = Date.now() - this.lastSaveTime;
        if (elapsed >= this.timeInterval) {
            return true;
        }

        return false;
    }

    /**
     * Save state to disk and reset counters.
     */
    private save(): void {
        saveTransferState(this.stateFile, this.state);
        this.lastSaveTime = Date.now();
        this.batchesSinceLastSave = 0;
        this.dirty = false;
    }

    /**
     * Force save if there are unsaved changes.
     * Call this before shutdown or on completion.
     */
    flush(): void {
        if (this.dirty) {
            this.save();
        }
    }

    /**
     * Get the underlying state object.
     */
    getState(): TransferState {
        return this.state;
    }
}

export function loadTransferState(stateFile: string): TransferState | null {
    try {
        if (!fs.existsSync(stateFile)) {
            return null;
        }
        const content = fs.readFileSync(stateFile, 'utf-8');
        const state = JSON.parse(content) as TransferState;

        if (state.version !== STATE_VERSION) {
            console.warn(
                `⚠️  State file version mismatch (expected ${STATE_VERSION}, got ${state.version})`
            );
            return null;
        }

        return state;
    } catch (error) {
        console.error(`⚠️  Failed to load state file: ${(error as Error).message}`);
        return null;
    }
}

export function saveTransferState(stateFile: string, state: TransferState): void {
    state.updatedAt = new Date().toISOString();
    const content = JSON.stringify(state, null, 2);
    const tempFile = `${stateFile}.tmp`;

    try {
        // Write to temp file first (atomic write pattern)
        fs.writeFileSync(tempFile, content);
        // Rename is atomic on most filesystems
        fs.renameSync(tempFile, stateFile);
    } catch (error) {
        // Clean up temp file if it exists
        try {
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
        } catch {
            // Ignore cleanup errors
        }
        // Log but don't throw - state save failure shouldn't stop the transfer
        console.error(`⚠️  Failed to save state file: ${(error as Error).message}`);
    }
}

export function deleteTransferState(stateFile: string): void {
    try {
        if (fs.existsSync(stateFile)) {
            fs.unlinkSync(stateFile);
        }
    } catch {
        // Ignore errors when deleting state file
    }
}

export function createInitialState(config: Config): TransferState {
    return {
        version: STATE_VERSION,
        sourceProject: config.sourceProject!,
        destProject: config.destProject!,
        collections: config.collections,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedDocs: {},
        stats: {
            collectionsProcessed: 0,
            documentsTransferred: 0,
            documentsDeleted: 0,
            errors: 0,
        },
    };
}

export function validateStateForResume(state: TransferState, config: Config): string[] {
    const errors: string[] = [];

    if (state.sourceProject !== config.sourceProject) {
        errors.push(
            `Source project mismatch: state has "${state.sourceProject}", config has "${config.sourceProject}"`
        );
    }
    if (state.destProject !== config.destProject) {
        errors.push(
            `Destination project mismatch: state has "${state.destProject}", config has "${config.destProject}"`
        );
    }

    // Check if collections are compatible (state collections should be subset of config)
    const configCollections = new Set(config.collections);
    for (const col of state.collections) {
        if (!configCollections.has(col)) {
            errors.push(`State contains collection "${col}" not in current config`);
        }
    }

    return errors;
}

export function isDocCompleted(
    state: TransferState,
    collectionPath: string,
    docId: string
): boolean {
    const completedInCollection = state.completedDocs[collectionPath];
    return completedInCollection ? completedInCollection.includes(docId) : false;
}

export function markDocCompleted(
    state: TransferState,
    collectionPath: string,
    docId: string
): void {
    if (!state.completedDocs[collectionPath]) {
        state.completedDocs[collectionPath] = [];
    }
    state.completedDocs[collectionPath].push(docId);
}
