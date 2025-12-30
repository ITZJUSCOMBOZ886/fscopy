import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '../utils/logger.js';
import { Output, parseSize } from '../utils/output.js';

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

    describe('log rotation', () => {
        test('rotates log file when exceeding maxSize', () => {
            // Create a log file with some content
            fs.writeFileSync(logFile, 'x'.repeat(100));

            const logger = new Logger({
                logPath: logFile,
                maxSize: 50, // 50 bytes
                maxFiles: 3,
            });
            logger.init();

            // Original file should be rotated
            const backupPath = path.join(tempDir, 'test.1.log');
            expect(fs.existsSync(backupPath)).toBe(true);
            expect(fs.readFileSync(backupPath, 'utf-8')).toBe('x'.repeat(100));

            // New file should have fresh header
            const content = fs.readFileSync(logFile, 'utf-8');
            expect(content).toContain('# fscopy transfer log');
        });

        test('shifts existing backups on rotation', () => {
            // Create existing backups
            fs.writeFileSync(logFile, 'current'.repeat(20));
            fs.writeFileSync(path.join(tempDir, 'test.1.log'), 'backup1');
            fs.writeFileSync(path.join(tempDir, 'test.2.log'), 'backup2');

            const logger = new Logger({
                logPath: logFile,
                maxSize: 50,
                maxFiles: 5,
            });
            logger.init();

            // Backups should shift
            expect(fs.readFileSync(path.join(tempDir, 'test.1.log'), 'utf-8')).toBe('current'.repeat(20));
            expect(fs.readFileSync(path.join(tempDir, 'test.2.log'), 'utf-8')).toBe('backup1');
            expect(fs.readFileSync(path.join(tempDir, 'test.3.log'), 'utf-8')).toBe('backup2');
        });

        test('deletes oldest backup when at maxFiles', () => {
            // Create max backups
            fs.writeFileSync(logFile, 'current'.repeat(20));
            fs.writeFileSync(path.join(tempDir, 'test.1.log'), 'backup1');
            fs.writeFileSync(path.join(tempDir, 'test.2.log'), 'backup2');

            const logger = new Logger({
                logPath: logFile,
                maxSize: 50,
                maxFiles: 2,
            });
            logger.init();

            // Oldest backup (test.2.log -> would be test.3.log) should be deleted
            expect(fs.existsSync(path.join(tempDir, 'test.1.log'))).toBe(true);
            expect(fs.existsSync(path.join(tempDir, 'test.2.log'))).toBe(true);
            expect(fs.existsSync(path.join(tempDir, 'test.3.log'))).toBe(false);
        });

        test('does not rotate when under maxSize', () => {
            fs.writeFileSync(logFile, 'small');

            const logger = new Logger({
                logPath: logFile,
                maxSize: 1000,
                maxFiles: 3,
            });
            logger.init();

            // No backup should be created
            expect(fs.existsSync(path.join(tempDir, 'test.1.log'))).toBe(false);
        });

        test('does not rotate when maxSize is 0', () => {
            fs.writeFileSync(logFile, 'x'.repeat(1000));

            const logger = new Logger({
                logPath: logFile,
                maxSize: 0, // Disabled
                maxFiles: 3,
            });
            logger.init();

            // No backup should be created
            expect(fs.existsSync(path.join(tempDir, 'test.1.log'))).toBe(false);
        });
    });
});

describe('parseSize', () => {
    test('returns 0 for undefined', () => {
        expect(parseSize(undefined)).toBe(0);
    });

    test('returns 0 for "0"', () => {
        expect(parseSize('0')).toBe(0);
    });

    test('returns 0 for empty string', () => {
        expect(parseSize('')).toBe(0);
    });

    test('parses bytes', () => {
        expect(parseSize('100')).toBe(100);
        expect(parseSize('100B')).toBe(100);
        expect(parseSize('100b')).toBe(100);
    });

    test('parses kilobytes', () => {
        expect(parseSize('1KB')).toBe(1024);
        expect(parseSize('10kb')).toBe(10 * 1024);
        expect(parseSize('1.5KB')).toBe(Math.floor(1.5 * 1024));
    });

    test('parses megabytes', () => {
        expect(parseSize('1MB')).toBe(1024 * 1024);
        expect(parseSize('10mb')).toBe(10 * 1024 * 1024);
        expect(parseSize('2.5MB')).toBe(Math.floor(2.5 * 1024 * 1024));
    });

    test('parses gigabytes', () => {
        expect(parseSize('1GB')).toBe(1024 * 1024 * 1024);
        expect(parseSize('2gb')).toBe(2 * 1024 * 1024 * 1024);
    });

    test('handles whitespace in unit', () => {
        expect(parseSize('10 MB')).toBe(10 * 1024 * 1024);
        expect(parseSize('  5KB  ')).toBe(5 * 1024);
    });

    test('returns 0 for invalid format', () => {
        expect(parseSize('abc')).toBe(0);
        expect(parseSize('MB10')).toBe(0);
        expect(parseSize('10TB')).toBe(0); // TB not supported
    });
});

describe('Output log rotation', () => {
    let tempDir: string;
    let logFile: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fscopy-output-test-'));
        logFile = path.join(tempDir, 'transfer.log');
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('rotates log file when exceeding maxLogSize', () => {
        fs.writeFileSync(logFile, 'x'.repeat(100));

        const output = new Output({
            logFile,
            maxLogSize: 50,
            maxLogFiles: 3,
        });
        output.init();

        const backupPath = path.join(tempDir, 'transfer.1.log');
        expect(fs.existsSync(backupPath)).toBe(true);
        expect(fs.readFileSync(backupPath, 'utf-8')).toBe('x'.repeat(100));
    });

    test('does not rotate when file does not exist', () => {
        const output = new Output({
            logFile,
            maxLogSize: 50,
        });
        output.init();

        expect(fs.existsSync(path.join(tempDir, 'transfer.1.log'))).toBe(false);
        expect(fs.existsSync(logFile)).toBe(true);
    });
});
