import readline from 'node:readline';
import type { Config, Stats } from '../types.js';

function formatIdModification(config: Config): string | null {
    if (!config.idPrefix && !config.idSuffix) return null;
    const parts = [
        config.idPrefix ? `prefix: "${config.idPrefix}"` : null,
        config.idSuffix ? `suffix: "${config.idSuffix}"` : null,
    ].filter(Boolean);
    return parts.join(', ');
}

function formatRenameCollections(config: Config): string | null {
    if (Object.keys(config.renameCollection).length === 0) return null;
    return Object.entries(config.renameCollection)
        .map(([src, dest]) => `${src}→${dest}`)
        .join(', ');
}

function displayAdditionalOptions(config: Config): void {
    const options: Array<{ condition: boolean; icon: string; label: string; value: string }> = [
        {
            condition: config.where.length > 0,
            icon: '🔍',
            label: 'Where filters',
            value: config.where.map((w) => `${w.field} ${w.operator} ${w.value}`).join(', '),
        },
        { condition: config.exclude.length > 0, icon: '🚫', label: 'Exclude patterns', value: config.exclude.join(', ') },
        { condition: config.merge, icon: '🔀', label: 'Merge mode', value: 'enabled (merge instead of overwrite)' },
        { condition: config.parallel > 1, icon: '⚡', label: 'Parallel transfers', value: `${config.parallel} collections` },
        { condition: config.clear, icon: '🗑️ ', label: 'Clear destination', value: 'enabled (DESTRUCTIVE)' },
        { condition: config.deleteMissing, icon: '🔄', label: 'Delete missing', value: 'enabled (sync mode)' },
        { condition: Boolean(config.transform), icon: '🔧', label: 'Transform', value: config.transform ?? '' },
        { condition: Boolean(formatRenameCollections(config)), icon: '📝', label: 'Rename collections', value: formatRenameCollections(config) ?? '' },
        { condition: Boolean(formatIdModification(config)), icon: '🏷️ ', label: 'ID modification', value: formatIdModification(config) ?? '' },
        { condition: config.rateLimit > 0, icon: '⏱️ ', label: 'Rate limit', value: `${config.rateLimit} docs/s` },
        { condition: config.skipOversized, icon: '📏', label: 'Skip oversized', value: 'enabled (skip docs > 1MB)' },
        { condition: config.detectConflicts, icon: '🔒', label: 'Detect conflicts', value: 'enabled' },
    ];

    for (const opt of options) {
        if (opt.condition) {
            console.log(`  ${opt.icon} ${opt.label.padEnd(18)} ${opt.value}`);
        }
    }
}

export function displayConfig(config: Config): void {
    console.log('='.repeat(60));
    console.log('🔄 FSCOPY - CONFIGURATION');
    console.log('='.repeat(60));
    console.log('');
    console.log(`  📤 Source project:       ${config.sourceProject || '(not set)'}`);
    console.log(`  📥 Destination project:  ${config.destProject || '(not set)'}`);
    console.log('');
    console.log(
        `  📋 Collections:          ${config.collections.length > 0 ? config.collections.join(', ') : '(none)'}`
    );
    console.log(`  📂 Include subcollections: ${config.includeSubcollections}`);
    console.log(`  🔢 Document limit:       ${config.limit === 0 ? 'No limit' : config.limit}`);
    console.log(`  📦 Batch size:           ${config.batchSize}`);
    console.log(`  🔄 Retries on error:     ${config.retries}`);

    displayAdditionalOptions(config);

    console.log('');
    console.log(config.dryRun
        ? '  🔍 Mode:                 DRY RUN (no data will be written)'
        : '  ⚡ Mode:                 LIVE (data WILL be transferred)');
    console.log('');
    console.log('='.repeat(60));
}

export async function askConfirmation(config: Config): Promise<boolean> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        const modeText = config.dryRun ? 'DRY RUN' : '⚠️  LIVE TRANSFER';
        rl.question(`\nProceed with ${modeText}? (y/N): `, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
        });
    });
}

export function printSummary(stats: Stats, duration: string, logFile?: string, dryRun?: boolean): void {
    console.log('\n' + '='.repeat(60));
    console.log('📊 TRANSFER SUMMARY');
    console.log('='.repeat(60));
    console.log(`Collections processed: ${stats.collectionsProcessed}`);
    if (stats.documentsDeleted > 0) {
        console.log(`Documents deleted:     ${stats.documentsDeleted}`);
    }
    console.log(`Documents transferred: ${stats.documentsTransferred}`);
    if (stats.conflicts > 0) {
        console.log(`Conflicts detected:    ${stats.conflicts}`);
    }
    console.log(`Errors: ${stats.errors}`);
    console.log(`Duration: ${duration}s`);

    if (logFile) {
        console.log(`Log file: ${logFile}`);
    }

    if (dryRun) {
        console.log('\n⚠ DRY RUN: No data was actually written');
        console.log('   Run with --dry-run=false to perform the transfer');
    } else {
        console.log('\n✓ Transfer completed successfully');
    }
    console.log('='.repeat(60) + '\n');
}

export function formatJsonOutput(
    success: boolean,
    config: Config,
    stats: Stats,
    duration: number,
    error?: string,
    verifyResult?: Record<string, { source: number; dest: number; match: boolean }> | null
): string {
    const output = {
        success,
        ...(error && { error }),
        dryRun: config.dryRun,
        source: config.sourceProject,
        destination: config.destProject,
        collections: config.collections,
        stats: {
            collectionsProcessed: stats.collectionsProcessed,
            documentsTransferred: stats.documentsTransferred,
            documentsDeleted: stats.documentsDeleted,
            errors: stats.errors,
            conflicts: stats.conflicts,
        },
        duration,
        ...(verifyResult && { verify: verifyResult }),
    };
    return JSON.stringify(output, null, 2);
}
