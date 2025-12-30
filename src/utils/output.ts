import fs from 'node:fs';
import type { Stats, LogEntry } from '../types.js';

export interface OutputOptions {
    quiet: boolean;
    json: boolean;
    logFile?: string;
}

/**
 * Unified output manager for console and file logging.
 * Handles quiet mode (--quiet) and JSON mode (--json).
 */
export class Output {
    private readonly options: OutputOptions;
    private readonly entries: LogEntry[] = [];
    private readonly startTime: Date;

    constructor(options: Partial<OutputOptions> = {}) {
        this.options = {
            quiet: options.quiet ?? false,
            json: options.json ?? false,
            logFile: options.logFile,
        };
        this.startTime = new Date();
    }

    // ==========================================================================
    // Initialization
    // ==========================================================================

    init(): void {
        if (this.options.logFile) {
            const header = `# fscopy transfer log\n# Started: ${this.startTime.toISOString()}\n\n`;
            fs.writeFileSync(this.options.logFile, header);
        }
    }

    // ==========================================================================
    // Console Output (respects quiet mode, skipped in JSON mode)
    // ==========================================================================

    /** Print info message to console */
    print(message: string): void {
        if (!this.options.json) {
            console.log(message);
        }
    }

    /** Print message (skipped in quiet mode) */
    private printIfNotQuiet(message: string): void {
        if (!this.options.quiet && !this.options.json) {
            console.log(message);
        }
    }

    /** Print info message (skipped in quiet mode) */
    info(message: string): void {
        this.printIfNotQuiet(message);
    }

    /** Print success message (skipped in quiet mode) */
    success(message: string): void {
        this.printIfNotQuiet(message);
    }

    /** Print warning message (always shown, except in JSON mode) */
    warn(message: string): void {
        if (!this.options.json) {
            console.warn(message);
        }
    }

    /** Print error message (always shown, except in JSON mode) */
    error(message: string): void {
        if (!this.options.json) {
            console.error(message);
        }
    }

    /** Print a blank line */
    blank(): void {
        if (!this.options.quiet && !this.options.json) {
            console.log('');
        }
    }

    /** Print a separator line */
    separator(char: string = '=', length: number = 60): void {
        if (!this.options.quiet && !this.options.json) {
            console.log(char.repeat(length));
        }
    }

    /** Print a header with separators */
    header(title: string): void {
        if (!this.options.quiet && !this.options.json) {
            console.log('='.repeat(60));
            console.log(title);
            console.log('='.repeat(60));
        }
    }

    // ==========================================================================
    // File Logging (always writes if logFile is set)
    // ==========================================================================

    /** Log entry to file only */
    log(level: string, message: string, data: Record<string, unknown> = {}): void {
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            ...data,
        };
        this.entries.push(entry);

        if (this.options.logFile) {
            const line =
                `[${entry.timestamp}] [${level}] ${message}` +
                (Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '') +
                '\n';
            fs.appendFileSync(this.options.logFile, line);
        }
    }

    /** Log info to file */
    logInfo(message: string, data?: Record<string, unknown>): void {
        this.log('INFO', message, data);
    }

    /** Log error to file */
    logError(message: string, data?: Record<string, unknown>): void {
        this.log('ERROR', message, data);
    }

    /** Log success to file */
    logSuccess(message: string, data?: Record<string, unknown>): void {
        this.log('SUCCESS', message, data);
    }

    /** Write summary to log file */
    logSummary(stats: Stats, duration: string): void {
        if (this.options.logFile) {
            let summary = `\n# Summary\n# Collections: ${stats.collectionsProcessed}\n`;
            if (stats.documentsDeleted > 0) {
                summary += `# Deleted: ${stats.documentsDeleted}\n`;
            }
            summary += `# Transferred: ${stats.documentsTransferred}\n# Errors: ${stats.errors}\n# Duration: ${duration}s\n`;
            fs.appendFileSync(this.options.logFile, summary);
        }
    }

    // ==========================================================================
    // JSON Output
    // ==========================================================================

    /** Print JSON output (only in JSON mode) */
    json(data: unknown): void {
        if (this.options.json) {
            console.log(JSON.stringify(data, null, 2));
        }
    }

    // ==========================================================================
    // Helpers
    // ==========================================================================

    get isQuiet(): boolean {
        return this.options.quiet;
    }

    get isJson(): boolean {
        return this.options.json;
    }

    get logFile(): string | undefined {
        return this.options.logFile;
    }
}

// Default singleton instance (can be replaced)
let defaultOutput: Output = new Output();

export function setDefaultOutput(output: Output): void {
    defaultOutput = output;
}

export function getDefaultOutput(): Output {
    return defaultOutput;
}
