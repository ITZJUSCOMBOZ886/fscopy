import readline from 'node:readline';
import type { Config, Stats } from '../types.js';

function displayAdditionalOptions(config: Config): void {
    if (config.where.length > 0) {
        const whereStr = config.where.map((w) => `${w.field} ${w.operator} ${w.value}`).join(', ');
        console.log(`  🔍 Where filters:        ${whereStr}`);
    }
    if (config.exclude.length > 0) {
        console.log(`  🚫 Exclude patterns:     ${config.exclude.join(', ')}`);
    }
    if (config.merge) {
        console.log(`  🔀 Merge mode:           enabled (merge instead of overwrite)`);
    }
    if (config.parallel > 1) {
        console.log(`  ⚡ Parallel transfers:   ${config.parallel} collections`);
    }
    if (config.clear) {
        console.log(`  🗑️  Clear destination:    enabled (DESTRUCTIVE)`);
    }
    if (config.deleteMissing) {
        console.log(`  🔄 Delete missing:       enabled (sync mode)`);
    }
    if (config.transform) {
        console.log(`  🔧 Transform:            ${config.transform}`);
    }
    if (Object.keys(config.renameCollection).length > 0) {
        const renameStr = Object.entries(config.renameCollection)
            .map(([src, dest]) => `${src}→${dest}`)
            .join(', ');
        console.log(`  📝 Rename collections:   ${renameStr}`);
    }
    if (config.idPrefix || config.idSuffix) {
        const idMod = [
            config.idPrefix ? `prefix: "${config.idPrefix}"` : null,
            config.idSuffix ? `suffix: "${config.idSuffix}"` : null,
        ]
            .filter(Boolean)
            .join(', ');
        console.log(`  🏷️  ID modification:      ${idMod}`);
    }
    if (config.rateLimit > 0) {
        console.log(`  ⏱️  Rate limit:          ${config.rateLimit} docs/s`);
    }
    if (config.skipOversized) {
        console.log(`  📏 Skip oversized:       enabled (skip docs > 1MB)`);
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
        },
        duration,
        ...(verifyResult && { verify: verifyResult }),
    };
    return JSON.stringify(output, null, 2);
}
