import { describe, test, expect } from 'bun:test';
import { RateLimiter } from '../utils/rate-limiter.js';

describe('RateLimiter', () => {
    test('isEnabled returns false for 0 rate', () => {
        const limiter = new RateLimiter(0);
        expect(limiter.isEnabled()).toBe(false);
    });

    test('isEnabled returns true for positive rate', () => {
        const limiter = new RateLimiter(100);
        expect(limiter.isEnabled()).toBe(true);
    });

    test('acquire resolves immediately when disabled', async () => {
        const limiter = new RateLimiter(0);
        const start = Date.now();
        await limiter.acquire(100);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(50);
    });

    test('acquire resolves immediately when tokens available', async () => {
        const limiter = new RateLimiter(100);
        const start = Date.now();
        await limiter.acquire(1);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(50);
    });

    test('acquire waits when tokens exhausted', async () => {
        const limiter = new RateLimiter(10); // 10 docs/second

        // Exhaust tokens
        await limiter.acquire(10);

        const start = Date.now();
        await limiter.acquire(5);
        const elapsed = Date.now() - start;

        // Should wait approximately 500ms for 5 tokens at 10/s
        expect(elapsed).toBeGreaterThanOrEqual(400);
        expect(elapsed).toBeLessThan(800);
    });

    test('tokens refill over time', async () => {
        const limiter = new RateLimiter(100); // 100 docs/second

        // Exhaust all tokens
        await limiter.acquire(100);

        // Wait 100ms for ~10 tokens to refill
        await new Promise((resolve) => setTimeout(resolve, 100));

        const start = Date.now();
        await limiter.acquire(5);
        const elapsed = Date.now() - start;

        // Should be almost immediate since tokens refilled
        expect(elapsed).toBeLessThan(100);
    });

    test('handles fractional tokens correctly', async () => {
        const limiter = new RateLimiter(1000); // 1000 docs/second = 1 per ms

        // This should work immediately
        await limiter.acquire(1);

        // Wait 10ms for ~10 tokens
        await new Promise((resolve) => setTimeout(resolve, 10));

        const start = Date.now();
        await limiter.acquire(5);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(50);
    });

    test('preserves excess tokens after waiting', async () => {
        const limiter = new RateLimiter(10); // 10 docs/second

        // Exhaust tokens
        await limiter.acquire(10);

        // Request 1 token - will wait ~100ms but accumulate ~1 token
        await limiter.acquire(1);

        // The next small request should be nearly instant
        // because we accumulated fractional excess tokens during the wait
        const start = Date.now();
        await limiter.acquire(1);
        const elapsed = Date.now() - start;

        // Should wait less than full 100ms since we have leftover tokens
        expect(elapsed).toBeLessThan(150);
    });
});
