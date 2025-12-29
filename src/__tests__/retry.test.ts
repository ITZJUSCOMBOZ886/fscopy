import { describe, test, expect, mock } from 'bun:test';

// =============================================================================
// Types
// =============================================================================

interface RetryOptions {
    retries?: number;
    baseDelay?: number;
    maxDelay?: number;
    onRetry?: (attempt: number, max: number, error: Error, delay: number) => void;
}

// =============================================================================
// Function to test (duplicated from cli.ts for isolated testing)
// =============================================================================

async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
    const { retries = 3, baseDelay = 1000, maxDelay = 30000, onRetry } = options;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error as Error;

            if (attempt < retries) {
                const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
                if (onRetry) {
                    onRetry(attempt + 1, retries, lastError, delay);
                }
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
}

// =============================================================================
// Tests
// =============================================================================

describe('withRetry', () => {
    test('returns result on first success', async () => {
        const fn = mock(() => Promise.resolve('success'));

        const result = await withRetry(fn, { retries: 3, baseDelay: 10 });

        expect(result).toBe('success');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('retries on failure and succeeds', async () => {
        let attempts = 0;
        const fn = mock(() => {
            attempts++;
            if (attempts < 3) {
                return Promise.reject(new Error('fail'));
            }
            return Promise.resolve('success');
        });

        const result = await withRetry(fn, { retries: 3, baseDelay: 10 });

        expect(result).toBe('success');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    test('throws after max retries', async () => {
        const fn = mock(() => Promise.reject(new Error('always fails')));

        await expect(withRetry(fn, { retries: 2, baseDelay: 10 })).rejects.toThrow('always fails');

        expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    test('calls onRetry callback on each retry', async () => {
        let attempts = 0;
        const fn = mock(() => {
            attempts++;
            if (attempts < 3) {
                return Promise.reject(new Error('fail'));
            }
            return Promise.resolve('success');
        });

        const onRetry = mock(() => {});

        await withRetry(fn, { retries: 3, baseDelay: 10, onRetry });

        expect(onRetry).toHaveBeenCalledTimes(2);
    });

    test('respects maxDelay', async () => {
        const fn = mock(() => Promise.reject(new Error('fail')));
        const onRetry = mock((_attempt: number, _max: number, _err: Error, delay: number) => {
            // With baseDelay=100, attempt 5 would be 100*2^4=1600, but maxDelay=500
            expect(delay).toBeLessThanOrEqual(500);
        });

        try {
            await withRetry(fn, { retries: 5, baseDelay: 100, maxDelay: 500, onRetry });
        } catch {
            // Expected to fail
        }
    });

    test('works with zero retries', async () => {
        const fn = mock(() => Promise.reject(new Error('fail')));

        await expect(withRetry(fn, { retries: 0, baseDelay: 10 })).rejects.toThrow('fail');

        expect(fn).toHaveBeenCalledTimes(1);
    });
});
