# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CLI tool to copy Firestore collections between Firebase projects. Built with Bun.

## Authentication

Uses Google Application Default Credentials (ADC). User must run:

```bash
gcloud auth application-default login
```

## Commands

```bash
bun install                              # Install dependencies
bun test                                 # Run tests
bun run type-check                       # TypeScript type checking
bun run lint                             # Run ESLint
bun run lint:fix                         # Fix ESLint errors
bun run format                           # Format with Prettier
bun run format:check                     # Check formatting

# Global CLI install (requires ~/.bun/bin in PATH)
bun add -g /Users/axel/EQ_Projects/small_programs/fscopy

# Update global CLI (same command)
bun add -g /Users/axel/EQ_Projects/small_programs/fscopy

# Remove global CLI
bun remove -g fscopy

# After global install:
fscopy --init config.ini     # Generate INI config (default)
fscopy --init config.json    # Generate JSON config
fscopy -f config.ini         # Run with config file
fscopy -c users orders -s    # Run with CLI args
fscopy -f config.ini -d false -y  # Live transfer
fscopy -f config.ini --log transfer.log  # With logging
fscopy -f config.ini --where "active == true"  # Filter docs
fscopy -f config.ini --exclude logs cache  # Exclude subcollections
fscopy -f config.ini --merge  # Merge instead of overwrite
fscopy -f config.ini --parallel 3  # Parallel transfers
fscopy -f config.ini --clear  # Clear destination before transfer

# Local development:
bun start -- -f config.ini              # Run locally
bun dev -- -f config.ini                # Run with watch mode
```

## Architecture

Single-file TypeScript CLI (`src/cli.ts`) with shebang `#!/usr/bin/env bun`.

**Key components:**

- `Logger` class - Handles file logging with timestamps
- `withRetry()` - Exponential backoff retry logic
- `cli-progress` - Progress bar with ETA

**Config resolution** (priority: CLI > config file > defaults):

- `loadConfigFile()` parses INI or JSON based on extension
- `parseIniConfig()` / `parseJsonConfig()` handle each format
- `mergeConfig()` combines config sources
- `validateConfig()` checks required fields

**Transfer flow:**

- `countDocuments()` - Counts total docs for progress bar
- `initializeFirebase()` - Creates two Firebase Admin apps (source/dest)
- `clearCollection()` - Deletes all docs from destination (when --clear is used)
- `transferCollection()` - Recursive function with retry handling
- `getSubcollections()` - Discovers nested collections via `listCollections()`

**Tests:**

- `src/__tests__/config.test.ts` - Config parsing and validation tests
- `src/__tests__/retry.test.ts` - Retry logic tests

## Config Options

INI format uses `[projects]` section for source/dest and `[transfer]` section for options.

| Option         | CLI                | INI key (section)          | JSON key                | Default  |
| -------------- | ------------------ | -------------------------- | ----------------------- | -------- |
| Source project | `--source-project` | `source` ([projects])      | `sourceProject`         | required |
| Dest project   | `--dest-project`   | `dest` ([projects])        | `destProject`           | required |
| Collections    | `-c`               | `collections` ([transfer]) | `collections`           | required |
| Subcollections | `-s`               | `includeSubcollections`    | `includeSubcollections` | false    |
| Dry run        | `-d`               | `dryRun`                   | `dryRun`                | true     |
| Batch size     | `-b`               | `batchSize`                | `batchSize`             | 500      |
| Doc limit      | `-l`               | `limit`                    | `limit`                 | 0 (none) |
| Skip confirm   | `-y`               | -                          | -                       | false    |
| Log file       | `--log`            | -                          | -                       | -        |
| Retries        | `--retries`        | -                          | -                       | 3        |
| Quiet mode     | `-q`               | -                          | -                       | false    |
| Where filter   | `-w`               | `where` ([options])        | `where`                 | []       |
| Exclude        | `-x`               | `exclude` ([options])      | `exclude`               | []       |
| Merge mode     | `-m`               | `merge` ([options])        | `merge`                 | false    |
| Parallel       | `-p`               | `parallel` ([options])     | `parallel`              | 1        |
| Clear dest     | `--clear`          | `clear` ([options])        | `clear`                 | false    |
