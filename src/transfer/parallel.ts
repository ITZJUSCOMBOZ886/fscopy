export interface ParallelResult<R> {
    results: R[];
    errors: Error[];
}

export async function processInParallel<T, R>(
    items: T[],
    concurrency: number,
    processor: (item: T) => Promise<R>
): Promise<ParallelResult<R>> {
    const results: R[] = [];
    const errors: Error[] = [];
    const queue = [...items];
    const executing: Set<Promise<void>> = new Set();

    const processNext = async (): Promise<void> => {
        if (queue.length === 0) return;

        const item = queue.shift()!;
        try {
            const result = await processor(item);
            results.push(result);
        } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
        }
    };

    // Start initial batch of concurrent tasks
    while (executing.size < concurrency && queue.length > 0) {
        const promise = processNext().then(() => {
            executing.delete(promise);
        });
        executing.add(promise);
    }

    // Process remaining items as slots become available
    while (queue.length > 0 || executing.size > 0) {
        if (executing.size > 0) {
            await Promise.race(executing);
        }
        // Fill up to concurrency limit
        while (executing.size < concurrency && queue.length > 0) {
            const promise = processNext().then(() => {
                executing.delete(promise);
            });
            executing.add(promise);
        }
    }

    return { results, errors };
}
