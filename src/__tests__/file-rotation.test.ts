import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { rotateFileIfNeeded } from '../utils/file-rotation.js';

describe('rotateFileIfNeeded', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fscopy-rotation-test-'));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    test('returns false when filePath is empty', () => {
        const result = rotateFileIfNeeded('', 1000);
        expect(result).toBe(false);
    });

    test('returns false when maxSize is 0', () => {
        const filePath = path.join(testDir, 'test.log');
        fs.writeFileSync(filePath, 'some content');

        const result = rotateFileIfNeeded(filePath, 0);
        expect(result).toBe(false);
    });

    test('returns false when maxSize is negative', () => {
        const filePath = path.join(testDir, 'test.log');
        fs.writeFileSync(filePath, 'some content');

        const result = rotateFileIfNeeded(filePath, -100);
        expect(result).toBe(false);
    });

    test('returns false when file does not exist', () => {
        const filePath = path.join(testDir, 'nonexistent.log');

        const result = rotateFileIfNeeded(filePath, 1000);
        expect(result).toBe(false);
    });

    test('returns false when file size is under maxSize', () => {
        const filePath = path.join(testDir, 'test.log');
        fs.writeFileSync(filePath, 'small content');

        const result = rotateFileIfNeeded(filePath, 1000);
        expect(result).toBe(false);
        expect(fs.existsSync(filePath)).toBe(true);
    });

    test('rotates file when size exceeds maxSize', () => {
        const filePath = path.join(testDir, 'test.log');
        const content = 'a'.repeat(100);
        fs.writeFileSync(filePath, content);

        const result = rotateFileIfNeeded(filePath, 50);

        expect(result).toBe(true);
        expect(fs.existsSync(filePath)).toBe(false);
        expect(fs.existsSync(path.join(testDir, 'test.1.log'))).toBe(true);
        expect(fs.readFileSync(path.join(testDir, 'test.1.log'), 'utf-8')).toBe(content);
    });

    test('shifts existing backups correctly', () => {
        const filePath = path.join(testDir, 'test.log');

        // Create existing backups
        fs.writeFileSync(path.join(testDir, 'test.1.log'), 'backup1');
        fs.writeFileSync(path.join(testDir, 'test.2.log'), 'backup2');
        fs.writeFileSync(filePath, 'a'.repeat(100));

        rotateFileIfNeeded(filePath, 50);

        expect(fs.existsSync(path.join(testDir, 'test.3.log'))).toBe(true);
        expect(fs.existsSync(path.join(testDir, 'test.2.log'))).toBe(true);
        expect(fs.existsSync(path.join(testDir, 'test.1.log'))).toBe(true);

        expect(fs.readFileSync(path.join(testDir, 'test.3.log'), 'utf-8')).toBe('backup2');
        expect(fs.readFileSync(path.join(testDir, 'test.2.log'), 'utf-8')).toBe('backup1');
        expect(fs.readFileSync(path.join(testDir, 'test.1.log'), 'utf-8')).toBe('a'.repeat(100));
    });

    test('deletes oldest backup when at max files', () => {
        const filePath = path.join(testDir, 'test.log');
        const maxFiles = 3;

        // Create existing backups at max
        fs.writeFileSync(path.join(testDir, 'test.1.log'), 'backup1');
        fs.writeFileSync(path.join(testDir, 'test.2.log'), 'backup2');
        fs.writeFileSync(path.join(testDir, 'test.3.log'), 'backup3-oldest');
        fs.writeFileSync(filePath, 'a'.repeat(100));

        rotateFileIfNeeded(filePath, 50, maxFiles);

        // Oldest should be deleted
        expect(fs.existsSync(path.join(testDir, 'test.4.log'))).toBe(false);

        // Others should be shifted
        expect(fs.readFileSync(path.join(testDir, 'test.3.log'), 'utf-8')).toBe('backup2');
        expect(fs.readFileSync(path.join(testDir, 'test.2.log'), 'utf-8')).toBe('backup1');
        expect(fs.readFileSync(path.join(testDir, 'test.1.log'), 'utf-8')).toBe('a'.repeat(100));
    });

    test('uses default maxFiles of 5', () => {
        const filePath = path.join(testDir, 'test.log');

        // Create 5 existing backups
        for (let i = 1; i <= 5; i++) {
            fs.writeFileSync(path.join(testDir, `test.${i}.log`), `backup${i}`);
        }
        fs.writeFileSync(filePath, 'a'.repeat(100));

        rotateFileIfNeeded(filePath, 50);

        // backup5 should be deleted (oldest)
        expect(fs.existsSync(path.join(testDir, 'test.6.log'))).toBe(false);
        expect(fs.existsSync(path.join(testDir, 'test.5.log'))).toBe(true);
        expect(fs.readFileSync(path.join(testDir, 'test.5.log'), 'utf-8')).toBe('backup4');
    });

    test('handles files without extension', () => {
        const filePath = path.join(testDir, 'logfile');
        fs.writeFileSync(filePath, 'a'.repeat(100));

        const result = rotateFileIfNeeded(filePath, 50);

        expect(result).toBe(true);
        expect(fs.existsSync(path.join(testDir, 'logfile.1'))).toBe(true);
    });

    test('handles files with multiple dots in name', () => {
        const filePath = path.join(testDir, 'my.app.log');
        fs.writeFileSync(filePath, 'a'.repeat(100));

        const result = rotateFileIfNeeded(filePath, 50);

        expect(result).toBe(true);
        expect(fs.existsSync(path.join(testDir, 'my.app.1.log'))).toBe(true);
    });

    test('handles exact size match (rotates when at limit)', () => {
        const filePath = path.join(testDir, 'test.log');
        const content = 'a'.repeat(100);
        fs.writeFileSync(filePath, content);

        // File size equals maxSize - rotates (size >= maxSize triggers rotation)
        const result = rotateFileIfNeeded(filePath, 100);
        expect(result).toBe(true);
        expect(fs.existsSync(path.join(testDir, 'test.1.log'))).toBe(true);
    });

    test('handles file size exactly 1 byte over', () => {
        const filePath = path.join(testDir, 'test.log');
        const content = 'a'.repeat(101);
        fs.writeFileSync(filePath, content);

        const result = rotateFileIfNeeded(filePath, 100);
        expect(result).toBe(true);
    });

    test('works with nested directories', () => {
        const nestedDir = path.join(testDir, 'logs', 'app');
        fs.mkdirSync(nestedDir, { recursive: true });
        const filePath = path.join(nestedDir, 'test.log');
        fs.writeFileSync(filePath, 'a'.repeat(100));

        const result = rotateFileIfNeeded(filePath, 50);

        expect(result).toBe(true);
        expect(fs.existsSync(path.join(nestedDir, 'test.1.log'))).toBe(true);
    });

    test('preserves file permissions during rotation', () => {
        const filePath = path.join(testDir, 'test.log');
        fs.writeFileSync(filePath, 'a'.repeat(100));

        rotateFileIfNeeded(filePath, 50);

        const backupPath = path.join(testDir, 'test.1.log');
        const stats = fs.statSync(backupPath);

        // File should be readable
        expect(stats.mode & 0o400).toBeTruthy();
    });
});
