import fs from 'node:fs';
import path from 'node:path';
import type { TransformFunction } from '../types.js';

export async function loadTransformFunction(transformPath: string): Promise<TransformFunction> {
    const absolutePath = path.resolve(transformPath);

    if (!fs.existsSync(absolutePath)) {
        throw new Error(`Transform file not found: ${absolutePath}`);
    }

    try {
        const module = await import(absolutePath);

        // Look for 'transform' export (default or named)
        const transformFn = module.default?.transform ?? module.transform ?? module.default;

        if (typeof transformFn !== 'function') {
            throw new TypeError(
                `Transform file must export a 'transform' function. Got: ${typeof transformFn}`
            );
        }

        return transformFn as TransformFunction;
    } catch (error) {
        if ((error as Error).message.includes('Transform file')) {
            throw error;
        }
        throw new Error(`Failed to load transform file: ${(error as Error).message}`);
    }
}
