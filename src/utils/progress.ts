import cliProgress from 'cli-progress';
import type { Stats } from '../types.js';

export interface ProgressBarOptions {
    format?: string;
    barCompleteChar?: string;
    barIncompleteChar?: string;
    hideCursor?: boolean;
}

const DEFAULT_OPTIONS: ProgressBarOptions = {
    format: '📦 Progress |{bar}| {percentage}% | {value}/{total} docs | {speed} docs/s | ETA: {eta}s',
    barCompleteChar: '█',
    barIncompleteChar: '░',
    hideCursor: true,
};

/**
 * Wrapper around cli-progress that handles speed calculation and cleanup.
 * Eliminates the need for type hacks to store the speed interval.
 */
export class ProgressBarWrapper {
    private bar: cliProgress.SingleBar | null = null;
    private speedInterval: NodeJS.Timeout | null = null;
    private lastDocsTransferred = 0;
    private lastTime = Date.now();

    constructor(private readonly options: ProgressBarOptions = {}) {}

    /**
     * Start the progress bar with the given total and stats reference.
     * The stats object is used to read documentsTransferred for speed calculation.
     */
    start(total: number, stats: Stats): void {
        if (total <= 0) return;

        const mergedOptions = { ...DEFAULT_OPTIONS, ...this.options };
        this.bar = new cliProgress.SingleBar({
            format: mergedOptions.format,
            barCompleteChar: mergedOptions.barCompleteChar,
            barIncompleteChar: mergedOptions.barIncompleteChar,
            hideCursor: mergedOptions.hideCursor,
        });

        this.bar.start(total, 0, { speed: '0' });
        this.lastDocsTransferred = 0;
        this.lastTime = Date.now();

        this.speedInterval = setInterval(() => {
            this.updateSpeed(stats);
        }, 500);
    }

    /**
     * Increment the progress bar by 1.
     */
    increment(): void {
        if (this.bar) {
            this.bar.increment();
        }
    }

    /**
     * Update the speed display based on current stats.
     */
    private updateSpeed(stats: Stats): void {
        if (!this.bar) return;

        const now = Date.now();
        const timeDiff = (now - this.lastTime) / 1000;
        const currentDocs = stats.documentsTransferred;

        if (timeDiff > 0) {
            const docsDiff = currentDocs - this.lastDocsTransferred;
            const speed = Math.round(docsDiff / timeDiff);
            this.lastDocsTransferred = currentDocs;
            this.lastTime = now;
            this.bar.update({ speed: String(speed) });
        }
    }

    /**
     * Stop the progress bar and clean up the speed interval.
     */
    stop(): void {
        if (this.speedInterval) {
            clearInterval(this.speedInterval);
            this.speedInterval = null;
        }
        if (this.bar) {
            this.bar.stop();
            this.bar = null;
        }
    }

    /**
     * Check if the progress bar is active.
     */
    get isActive(): boolean {
        return this.bar !== null;
    }
}
