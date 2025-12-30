import { describe, test, expect } from 'bun:test';
import { processInParallel } from '../transfer/parallel.js';

describe('processInParallel', () => {
    test('processes empty array', async () => {
        const result = await processInParallel([], 3, async (x) => x);
        expect(result.results).toEqual([]);
        expect(result.errors).toEqual([]);
    });

    test('processes single item', async () => {
        const result = await processInParallel([1], 3, async (x) => x * 2);
        expect(result.results).toEqual([2]);
        expect(result.errors).toEqual([]);
    });

    test('processes multiple items', async () => {
        const result = await processInParallel([1, 2, 3, 4, 5], 3, async (x) => x * 2);
        expect(result.results.sort((a, b) => a - b)).toEqual([2, 4, 6, 8, 10]);
        expect(result.errors).toEqual([]);
    });

    test('respects concurrency limit', async () => {
        let maxConcurrent = 0;
        let currentConcurrent = 0;

        const result = await processInParallel(
            [1, 2, 3, 4, 5, 6],
            2,
            async (x) => {
                currentConcurrent++;
                maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
                await new Promise((resolve) => setTimeout(resolve, 50));
                currentConcurrent--;
                return x;
            }
        );

        expect(maxConcurrent).toBeLessThanOrEqual(2);
        expect(result.results).toHaveLength(6);
    });

    test('collects errors without stopping', async () => {
        const result = await processInParallel(
            [1, 2, 3, 4, 5],
            2,
            async (x) => {
                if (x === 3) throw new Error('Error on 3');
                return x * 2;
            }
        );

        expect(result.results.sort((a, b) => a - b)).toEqual([2, 4, 8, 10]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toBe('Error on 3');
    });

    test('handles multiple errors', async () => {
        const result = await processInParallel(
            [1, 2, 3, 4, 5],
            3,
            async (x) => {
                if (x % 2 === 0) throw new Error(`Error on ${x}`);
                return x;
            }
        );

        expect(result.results.sort((a, b) => a - b)).toEqual([1, 3, 5]);
        expect(result.errors).toHaveLength(2);
    });

    test('handles all failures', async () => {
        const result = await processInParallel(
            [1, 2, 3],
            2,
            async () => {
                throw new Error('Always fails');
            }
        );

        expect(result.results).toEqual([]);
        expect(result.errors).toHaveLength(3);
    });

    test('converts non-Error throws to Error', async () => {
        const result = await processInParallel(
            [1],
            1,
            async () => {
                throw 'string error';
            }
        );

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toBeInstanceOf(Error);
        expect(result.errors[0].message).toBe('string error');
    });

    test('processes in parallel order (not sequential)', async () => {
        const startTime = Date.now();

        await processInParallel(
            [1, 2, 3, 4],
            4,
            async () => {
                await new Promise((resolve) => setTimeout(resolve, 100));
                return 1;
            }
        );

        const elapsed = Date.now() - startTime;
        // If sequential, would take ~400ms. With 4 parallel, should be ~100ms
        expect(elapsed).toBeLessThan(250);
    });

    test('handles concurrency of 1 (sequential)', async () => {
        const order: number[] = [];

        await processInParallel(
            [1, 2, 3],
            1,
            async (x) => {
                order.push(x);
                await new Promise((resolve) => setTimeout(resolve, 10));
                return x;
            }
        );

        expect(order).toEqual([1, 2, 3]);
    });

    test('handles more concurrency than items', async () => {
        const result = await processInParallel(
            [1, 2],
            10,
            async (x) => x * 2
        );

        expect(result.results.sort((a, b) => a - b)).toEqual([2, 4]);
    });

    test('works with async processors that return different types', async () => {
        const result = await processInParallel(
            ['a', 'bb', 'ccc'],
            2,
            async (s) => s.length
        );

        expect(result.results.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    });
});
