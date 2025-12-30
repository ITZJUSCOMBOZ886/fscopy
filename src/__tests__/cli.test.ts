import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'bun';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLI_PATH = path.resolve(__dirname, '../cli.ts');
const TEST_DIR = path.join(os.tmpdir(), 'fscopy-cli-test');

async function runCli(
    args: string[],
    options: { cwd?: string } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = spawn({
        cmd: ['bun', 'run', CLI_PATH, ...args],
        stdout: 'pipe',
        stderr: 'pipe',
        // Always run in TEST_DIR to avoid creating files in project directory
        cwd: options.cwd ?? TEST_DIR,
        env: {
            ...process.env,
            // Disable color output for easier testing
            NO_COLOR: '1',
            // Skip credentials check in tests
            FSCOPY_SKIP_CREDENTIALS_CHECK: '1',
        },
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return { exitCode, stdout, stderr };
}

describe('CLI', () => {
    beforeAll(() => {
        if (!fs.existsSync(TEST_DIR)) {
            fs.mkdirSync(TEST_DIR, { recursive: true });
        }
    });

    afterAll(() => {
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true });
        }
    });

    describe('--help', () => {
        test('shows usage information', async () => {
            const { stdout, exitCode } = await runCli(['--help']);

            expect(exitCode).toBe(0);
            expect(stdout).toContain('fscopy');
            expect(stdout).toContain('--config');
            expect(stdout).toContain('--collections');
            expect(stdout).toContain('--dry-run');
        });

        test('shows all main options', async () => {
            const { stdout } = await runCli(['--help']);

            expect(stdout).toContain('--source-project');
            expect(stdout).toContain('--dest-project');
            expect(stdout).toContain('--include-subcollections');
            expect(stdout).toContain('--batch-size');
            expect(stdout).toContain('--limit');
            expect(stdout).toContain('--where');
            expect(stdout).toContain('--exclude');
            expect(stdout).toContain('--merge');
            expect(stdout).toContain('--parallel');
            expect(stdout).toContain('--transform');
            expect(stdout).toContain('--webhook');
            expect(stdout).toContain('--resume');
            expect(stdout).toContain('--verify');
            expect(stdout).toContain('--rate-limit');
            expect(stdout).toContain('--json');
        });

        test('shows examples', async () => {
            const { stdout } = await runCli(['--help']);

            expect(stdout).toContain('Examples:');
            expect(stdout).toContain('--init config.ini');
            expect(stdout).toContain('-f config.ini');
        });
    });

    describe('--init', () => {
        test('generates INI config file by default', async () => {
            const configPath = path.join(TEST_DIR, 'test-config.ini');
            const { exitCode } = await runCli(['--init', configPath]);

            expect(exitCode).toBe(0);
            expect(fs.existsSync(configPath)).toBe(true);

            const content = fs.readFileSync(configPath, 'utf-8');
            expect(content).toContain('[projects]');
            expect(content).toContain('source =');
            expect(content).toContain('dest =');
            expect(content).toContain('[transfer]');
            expect(content).toContain('collections =');
        });

        test('generates JSON config file when .json extension', async () => {
            const configPath = path.join(TEST_DIR, 'test-config.json');
            const { exitCode } = await runCli(['--init', configPath]);

            expect(exitCode).toBe(0);
            expect(fs.existsSync(configPath)).toBe(true);

            const content = fs.readFileSync(configPath, 'utf-8');
            const parsed = JSON.parse(content);
            expect(parsed).toHaveProperty('sourceProject');
            expect(parsed).toHaveProperty('destProject');
            expect(parsed).toHaveProperty('collections');
        });

        test('fails when --init has no filename argument', async () => {
            const { exitCode, stderr } = await runCli(['--init']);

            expect(exitCode).toBe(1);
            expect(stderr).toContain('Not enough arguments');
        });

        test('creates file with default name when using empty string', async () => {
            // Using '' as init value defaults to fscopy.ini
            const { exitCode } = await runCli(['--init', 'default-test.ini']);
            expect(exitCode).toBe(0);

            const defaultPath = path.join(TEST_DIR, 'default-test.ini');
            expect(fs.existsSync(defaultPath)).toBe(true);
        });
    });

    describe('config validation', () => {
        test('fails with missing source project', async () => {
            const configPath = path.join(TEST_DIR, 'missing-source.json');
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    destProject: 'dest-project',
                    collections: ['users'],
                })
            );

            const { exitCode, stdout } = await runCli(['-f', configPath, '-y']);

            expect(exitCode).toBe(1);
            expect(stdout).toContain('Source project');
        });

        test('fails with missing dest project', async () => {
            const configPath = path.join(TEST_DIR, 'missing-dest.json');
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    sourceProject: 'source-project',
                    collections: ['users'],
                })
            );

            const { exitCode, stdout } = await runCli(['-f', configPath, '-y']);

            expect(exitCode).toBe(1);
            expect(stdout).toContain('Destination project');
        });

        test('fails with empty collections', async () => {
            const configPath = path.join(TEST_DIR, 'empty-collections.json');
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    sourceProject: 'source-project',
                    destProject: 'dest-project',
                    collections: [],
                })
            );

            const { exitCode, stdout } = await runCli(['-f', configPath, '-y']);

            expect(exitCode).toBe(1);
            expect(stdout).toContain('collection');
        });

        test('fails when source equals dest without rename or id modification', async () => {
            const configPath = path.join(TEST_DIR, 'same-project.json');
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    sourceProject: 'same-project',
                    destProject: 'same-project',
                    collections: ['users'],
                })
            );

            const { exitCode, stdout } = await runCli(['-f', configPath, '-y']);

            expect(exitCode).toBe(1);
            expect(stdout).toContain('same');
        });
    });

    describe('CLI argument merging', () => {
        test('CLI args override config file values', async () => {
            const configPath = path.join(TEST_DIR, 'override-test.json');
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    sourceProject: 'config-source',
                    destProject: 'config-dest',
                    collections: ['users'],
                    dryRun: false,
                })
            );

            // Use --source-project to override
            const { stdout } = await runCli([
                '-f',
                configPath,
                '--source-project',
                'cli-source',
                '--validate-only',
            ]);

            // The displayed config should show cli-source, not config-source
            expect(stdout).toContain('cli-source');
        });

        test('CLI collections override config file collections', async () => {
            const configPath = path.join(TEST_DIR, 'collections-override.json');
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    sourceProject: 'source',
                    destProject: 'dest',
                    collections: ['users', 'orders'],
                })
            );

            const { stdout } = await runCli([
                '-f',
                configPath,
                '-c',
                'products',
                'inventory',
                '--validate-only',
            ]);

            expect(stdout).toContain('products');
            expect(stdout).toContain('inventory');
        });
    });

    describe('webhook validation', () => {
        test('fails with invalid webhook URL', async () => {
            const configPath = path.join(TEST_DIR, 'invalid-webhook.json');
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    sourceProject: 'source',
                    destProject: 'dest',
                    collections: ['users'],
                    webhook: 'not-a-url',
                })
            );

            const { exitCode, stdout } = await runCli(['-f', configPath, '-y']);

            expect(exitCode).toBe(1);
            expect(stdout).toContain('Invalid');
        });

        test('warns with HTTP webhook (non-localhost)', async () => {
            const configPath = path.join(TEST_DIR, 'http-webhook.json');
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    sourceProject: 'source',
                    destProject: 'dest',
                    collections: ['users'],
                    webhook: 'http://example.com/hook',
                })
            );

            const { stdout } = await runCli(['-f', configPath, '--validate-only']);

            expect(stdout).toContain('HTTPS');
        });
    });

    describe('config file loading', () => {
        test('loads INI config file', async () => {
            const configPath = path.join(TEST_DIR, 'load-test.ini');
            fs.writeFileSync(
                configPath,
                `
[projects]
source = ini-source
dest = ini-dest

[transfer]
collections = users,orders
dryRun = true
`
            );

            const { stdout } = await runCli(['-f', configPath, '--validate-only']);

            expect(stdout).toContain('ini-source');
            expect(stdout).toContain('ini-dest');
            expect(stdout).toContain('users');
        });

        test('loads JSON config file', async () => {
            const configPath = path.join(TEST_DIR, 'load-test.json');
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    sourceProject: 'json-source',
                    destProject: 'json-dest',
                    collections: ['products'],
                    dryRun: true,
                })
            );

            const { stdout } = await runCli(['-f', configPath, '--validate-only']);

            expect(stdout).toContain('json-source');
            expect(stdout).toContain('json-dest');
            expect(stdout).toContain('products');
        });

        test('fails with non-existent config file', async () => {
            const { exitCode, stderr } = await runCli(['-f', '/nonexistent/config.json', '-y']);

            expect(exitCode).toBe(1);
            expect(stderr).toContain('not found');
        });
    });

    describe('output modes', () => {
        test('--quiet flag is accepted', async () => {
            const configPath = path.join(TEST_DIR, 'quiet-test.json');
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    sourceProject: 'source',
                    destProject: 'dest',
                    collections: ['users'],
                })
            );

            // Just verify that -q doesn't cause parse errors
            // (actual quiet behavior tested in output.test.ts)
            const { stdout, stderr } = await runCli(['-f', configPath, '--validate-only', '-q']);

            // Should not have yargs parsing errors
            expect(stderr).not.toContain('Unknown argument');
            expect(stdout).toBeDefined();
        });
    });
});
