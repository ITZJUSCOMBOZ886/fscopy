import fs from 'node:fs';
import type { Config, TransferState } from '../types.js';

export const STATE_VERSION = 1;

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
