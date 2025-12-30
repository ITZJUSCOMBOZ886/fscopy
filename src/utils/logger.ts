import fs from 'node:fs';
import path from 'node:path';
import type { Stats, LogEntry } from '../types.js';

export interface LoggerOptions {
    logPath?: string;
    maxSize?: number; // Max size in bytes (0 = unlimited)
    maxFiles?: number; // Max number of rotated files to keep
}

export class Logger {
    private readonly logPath: string | undefined;
    private readonly entries: LogEntry[] = [];
    private readonly startTime: Date;
    private readonly maxSize: number;
    private readonly maxFiles: number;

    constructor(optionsOrPath?: LoggerOptions | string) {
        // Backward compatibility: accept string as logPath
        const options: LoggerOptions = typeof optionsOrPath === 'string'
            ? { logPath: optionsOrPath }
            : optionsOrPath ?? {};

        this.logPath = options.logPath;
        this.maxSize = options.maxSize ?? 0;
        this.maxFiles = options.maxFiles ?? 5;
        this.startTime = new Date();
    }

    log(level: string, message: string, data: Record<string, unknown> = {}): void {
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            ...data,
        };
        this.entries.push(entry);

        if (this.logPath) {
            const line =
                `[${entry.timestamp}] [${level}] ${message}` +
                (Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '') +
                '\n';
            fs.appendFileSync(this.logPath, line);
        }
    }

    info(message: string, data?: Record<string, unknown>): void {
        this.log('INFO', message, data);
    }

    error(message: string, data?: Record<string, unknown>): void {
        this.log('ERROR', message, data);
    }

    success(message: string, data?: Record<string, unknown>): void {
        this.log('SUCCESS', message, data);
    }

    init(): void {
        if (this.logPath) {
            this.rotateIfNeeded();
            const header = `# fscopy transfer log\n# Started: ${this.startTime.toISOString()}\n\n`;
            fs.writeFileSync(this.logPath, header);
        }
    }

    /**
     * Rotate log file if it exceeds maxSize.
     * Creates numbered backups: log.1, log.2, etc.
     */
    private rotateIfNeeded(): void {
        if (!this.logPath || this.maxSize <= 0) return;
        if (!fs.existsSync(this.logPath)) return;

        const stats = fs.statSync(this.logPath);
        if (stats.size < this.maxSize) return;

        // Rotate existing backups
        const dir = path.dirname(this.logPath);
        const ext = path.extname(this.logPath);
        const base = path.basename(this.logPath, ext);

        // Delete oldest if at max
        const oldestPath = path.join(dir, `${base}.${this.maxFiles}${ext}`);
        if (fs.existsSync(oldestPath)) {
            fs.unlinkSync(oldestPath);
        }

        // Shift existing backups: .4 -> .5, .3 -> .4, etc.
        for (let i = this.maxFiles - 1; i >= 1; i--) {
            const from = path.join(dir, `${base}.${i}${ext}`);
            const to = path.join(dir, `${base}.${i + 1}${ext}`);
            if (fs.existsSync(from)) {
                fs.renameSync(from, to);
            }
        }

        // Rename current to .1
        const backupPath = path.join(dir, `${base}.1${ext}`);
        fs.renameSync(this.logPath, backupPath);
    }

    summary(stats: Stats, duration: string): void {
        if (this.logPath) {
            let summary = `\n# Summary\n# Collections: ${stats.collectionsProcessed}\n`;
            if (stats.documentsDeleted > 0) {
                summary += `# Deleted: ${stats.documentsDeleted}\n`;
            }
            summary += `# Transferred: ${stats.documentsTransferred}\n`;
            if (stats.conflicts > 0) {
                summary += `# Conflicts: ${stats.conflicts}\n`;
            }
            summary += `# Errors: ${stats.errors}\n# Duration: ${duration}s\n`;
            fs.appendFileSync(this.logPath, summary);
        }
    }
}
