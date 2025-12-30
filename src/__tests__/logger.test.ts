import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '../utils/logger.js';

describe('Logger', () => {
    let tempDir: string;
    let logFile: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fscopy-logger-test-'));
        logFile = path.join(tempDir, 'test.log');
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('constructor', () => {
        test('creates logger without log path', () => {
            const logger = new Logger();
            expect(logger).toBeDefined();
        });

        test('creates logger with log path', () => {
            const logger = new Logger(logFile);
            expect(logger).toBeDefined();
        });
    });

    describe('init', () => {
        test('creates log file with header', () => {
            const logger = new Logger(logFile);
            logger.init();

            expect(fs.existsSync(logFile)).toBe(true);
            const content = fs.readFileSync(logFile, 'utf-8');
            expect(content).toContain('# fscopy transfer log');
            expect(content).toContain('# Started:');
        });

        test('does nothing without log path', () => {
            const logger = new Logger();
            expect(() => logger.init()).not.toThrow();
        });
    });

    describe('log', () => {
        test('appends log entry to file', () => {
            const logger = new Logger(logFile);
            logger.init();
            logger.log('INFO', 'Test message');

            const content = fs.readFileSync(logFile, 'utf-8');
            expect(content).toContain('[INFO]');
            expect(content).toContain('Test message');
        });

        test('includes data in log entry', () => {
            const logger = new Logger(logFile);
            logger.init();
            logger.log('INFO', 'Test message', { key: 'value', count: 42 });

            const content = fs.readFileSync(logFile, 'utf-8');
            expect(content).toContain('"key":"value"');
            expect(content).toContain('"count":42');
        });

        test('does not write without log path', () => {
            const logger = new Logger();
            expect(() => logger.log('INFO', 'Test')).not.toThrow();
        });
    });

    describe('info', () => {
        test('logs with INFO level', () => {
            const logger = new Logger(logFile);
            logger.init();
            logger.info('Info message');

            const content = fs.readFileSync(logFile, 'utf-8');
            expect(content).toContain('[INFO]');
            expect(content).toContain('Info message');
        });
    });

    describe('error', () => {
        test('logs with ERROR level', () => {
            const logger = new Logger(logFile);
            logger.init();
            logger.error('Error message');

            const content = fs.readFileSync(logFile, 'utf-8');
            expect(content).toContain('[ERROR]');
            expect(content).toContain('Error message');
        });
    });

    describe('success', () => {
        test('logs with SUCCESS level', () => {
            const logger = new Logger(logFile);
            logger.init();
            logger.success('Success message');

            const content = fs.readFileSync(logFile, 'utf-8');
            expect(content).toContain('[SUCCESS]');
            expect(content).toContain('Success message');
        });
    });

    describe('summary', () => {
        test('appends summary to log file', () => {
            const logger = new Logger(logFile);
            logger.init();
            logger.summary(
                {
                    collectionsProcessed: 5,
                    documentsTransferred: 100,
                    documentsDeleted: 10,
                    errors: 2,
                },
                '12.34'
            );

            const content = fs.readFileSync(logFile, 'utf-8');
            expect(content).toContain('# Summary');
            expect(content).toContain('# Collections: 5');
            expect(content).toContain('# Transferred: 100');
            expect(content).toContain('# Deleted: 10');
            expect(content).toContain('# Errors: 2');
            expect(content).toContain('# Duration: 12.34s');
        });

        test('omits deleted line when zero', () => {
            const logger = new Logger(logFile);
            logger.init();
            logger.summary(
                {
                    collectionsProcessed: 1,
                    documentsTransferred: 10,
                    documentsDeleted: 0,
                    errors: 0,
                },
                '1.00'
            );

            const content = fs.readFileSync(logFile, 'utf-8');
            expect(content).not.toContain('# Deleted:');
        });

        test('does nothing without log path', () => {
            const logger = new Logger();
            expect(() =>
                logger.summary(
                    { collectionsProcessed: 0, documentsTransferred: 0, documentsDeleted: 0, errors: 0 },
                    '0'
                )
            ).not.toThrow();
        });
    });

    describe('multiple log entries', () => {
        test('preserves order of entries', () => {
            const logger = new Logger(logFile);
            logger.init();
            logger.info('First');
            logger.error('Second');
            logger.success('Third');

            const content = fs.readFileSync(logFile, 'utf-8');
            const firstIndex = content.indexOf('First');
            const secondIndex = content.indexOf('Second');
            const thirdIndex = content.indexOf('Third');

            expect(firstIndex).toBeLessThan(secondIndex);
            expect(secondIndex).toBeLessThan(thirdIndex);
        });
    });
});
