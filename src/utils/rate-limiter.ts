/**
 * Simple rate limiter using token bucket algorithm
 * Limits the rate of operations per second
 */
export class RateLimiter {
    private tokens: number;
    private lastRefill: number;
    private readonly maxTokens: number;
    private readonly refillRate: number; // tokens per ms

    /**
     * Create a rate limiter
     * @param docsPerSecond Maximum documents per second (0 = unlimited)
     */
    constructor(docsPerSecond: number) {
        this.maxTokens = docsPerSecond;
        this.tokens = docsPerSecond;
        this.lastRefill = Date.now();
        this.refillRate = docsPerSecond / 1000; // tokens per ms
    }

    /**
     * Check if rate limiting is enabled
     */
    isEnabled(): boolean {
        return this.maxTokens > 0;
    }

    /**
     * Wait until we can proceed with the given number of operations
     * @param count Number of operations to perform
     */
    async acquire(count: number = 1): Promise<void> {
        if (!this.isEnabled()) return;

        // Refill tokens based on time elapsed
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
        this.lastRefill = now;

        // If we have enough tokens, consume and proceed
        if (this.tokens >= count) {
            this.tokens -= count;
            return;
        }

        // Wait for tokens to be available
        const tokensNeeded = count - this.tokens;
        const waitTime = Math.ceil(tokensNeeded / this.refillRate);

        await this.sleep(waitTime);

        // After waiting, we should have enough tokens
        this.tokens = 0; // We consumed them all
        this.lastRefill = Date.now();
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
