# fscopy

[![CI](https://github.com/fazetitans/fscopy/actions/workflows/ci.yml/badge.svg)](https://github.com/fazetitans/fscopy/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/fscopy.svg)](https://www.npmjs.com/package/fscopy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Fast CLI tool to copy Firestore collections between Firebase projects

Transfer documents between Firebase projects with support for subcollections, filtering, parallel transfers, and merge mode. Built with [Bun](https://bun.sh) for maximum performance.

## Features

- **Subcollection support** - Recursively copy nested collections
- **Document filtering** - Filter documents with `--where` clauses
- **Exclude patterns** - Skip subcollections by name or glob pattern
- **Merge mode** - Update existing documents instead of overwriting
- **Parallel transfers** - Copy multiple collections simultaneously
- **Clear destination** - Optionally delete destination data before transfer
- **Sync mode** - Delete destination docs not present in source
- **Interactive mode** - Guided setup with prompts for project and collection selection
- **Progress bar** - Real-time progress with ETA
- **Automatic retry** - Exponential backoff on network errors
- **Dry run mode** - Preview changes before applying (enabled by default)
- **Flexible config** - INI, JSON, or CLI arguments

## Installation

### With Bun (recommended)

```bash
# Global install
bun add -g fscopy

# Or run directly
bunx fscopy --help
```

### With npm

```bash
npm install -g fscopy
```

### Prerequisites

1. [Bun](https://bun.sh) or Node.js 18+
1. Google Cloud authentication: `gcloud auth application-default login`
1. Firestore read access on source project, write access on destination

## Quick Start

```bash
# 1. Generate config file
fscopy --init config.ini

# 2. Edit config.ini with your project IDs and collections

# 3. Preview transfer (dry run)
fscopy -f config.ini

# 4. Execute transfer
fscopy -f config.ini -d false -y
```

## Usage

### Basic Transfer

```bash
# Using config file
fscopy -f config.ini

# Using CLI arguments
fscopy \
  --source-project my-source \
  --dest-project my-dest \
  -c users orders products
```

### With Subcollections

```bash
# Include all subcollections
fscopy -f config.ini -s

# Exclude specific subcollections
fscopy -f config.ini -s --exclude logs --exclude "temp/*"
```

### Filtering Documents

```bash
# Single filter
fscopy -f config.ini --where "status == active"

# Multiple filters (AND)
fscopy -f config.ini -w "active == true" -w "createdAt > 2024-01-01"

# Supported operators: ==, !=, <, >, <=, >=
```

### Advanced Options

```bash
# Merge mode (update instead of overwrite)
fscopy -f config.ini --merge

# Parallel transfers (3 collections at once)
fscopy -f config.ini --parallel 3

# With logging
fscopy -f config.ini --log transfer.log

# Limit documents per collection
fscopy -f config.ini --limit 100

# Quiet mode (no progress bar)
fscopy -f config.ini -q

# Clear destination before transfer (DESTRUCTIVE)
fscopy -f config.ini --clear

# Sync mode: delete orphan docs in destination
fscopy -f config.ini --delete-missing

# Interactive mode with prompts
fscopy -i
```

## Configuration

### INI Format (recommended)

```bash
fscopy --init config.ini
```

```ini
[projects]
source = my-source-project
dest = my-dest-project

[transfer]
collections = users, orders, products
includeSubcollections = true
dryRun = true
batchSize = 500
limit = 0

[options]
; where = status == active
; exclude = logs, cache, temp/*
merge = false
parallel = 1
clear = false
deleteMissing = false
```

### JSON Format

```bash
fscopy --init config.json
```

```json
{
  "sourceProject": "my-source-project",
  "destProject": "my-dest-project",
  "collections": ["users", "orders"],
  "includeSubcollections": true,
  "dryRun": true,
  "batchSize": 500,
  "limit": 0,
  "where": ["status == active"],
  "exclude": ["logs", "cache"],
  "merge": false,
  "parallel": 1,
  "clear": false,
  "deleteMissing": false
}
```

## CLI Reference

| Option | Alias | Type | Default | Description |
| ------ | ----- | ---- | ------- | ----------- |
| `--init` |  | string |  | Generate config template |
| `--config` | `-f` | string |  | Path to config file |
| `--source-project` |  | string |  | Source Firebase project |
| `--dest-project` |  | string |  | Destination project |
| `--collections` | `-c` | array |  | Collections to transfer |
| `--include-subcollections` | `-s` | boolean | `false` | Include subcollections |
| `--where` | `-w` | array |  | Filter documents |
| `--exclude` | `-x` | array |  | Exclude subcollections |
| `--merge` | `-m` | boolean | `false` | Merge instead of overwrite |
| `--parallel` | `-p` | number | `1` | Parallel transfers |
| `--dry-run` | `-d` | boolean | `true` | Preview without writing |
| `--batch-size` | `-b` | number | `500` | Documents per batch |
| `--limit` | `-l` | number | `0` | Limit docs (0 = no limit) |
| `--retries` |  | number | `3` | Retries on error |
| `--log` |  | string |  | Log file path |
| `--quiet` | `-q` | boolean | `false` | No progress bar |
| `--yes` | `-y` | boolean | `false` | Skip confirmation |
| `--clear` |  | boolean | `false` | Clear destination before transfer |
| `--delete-missing` |  | boolean | `false` | Delete dest docs not in source |
| `--interactive` | `-i` | boolean | `false` | Interactive mode with prompts |

## How It Works

1. **Authentication** - Uses Google Application Default Credentials (ADC)
2. **Document counting** - Counts total documents for progress bar
3. **Batch processing** - Transfers documents in configurable batches
4. **Retry logic** - Automatic retry with exponential backoff on failures
5. **Subcollection discovery** - Uses `listCollections()` to find nested data

## Notes

- **Dry run is ON by default** - Use `-d false` for actual transfer
- **Documents are overwritten** - Use `--merge` to update instead
- **Where filters apply to root only** - Subcollections are copied in full
- **Exclude patterns support globs** - e.g., `temp/*`, `*/logs`
- **Progress bar shows ETA** - Based on documents processed
- **Clear is destructive** - `--clear` deletes all destination docs before transfer
- **Delete-missing syncs** - `--delete-missing` removes orphan docs after transfer

## Development

```bash
# Clone and install
git clone https://github.com/fazetitans/fscopy.git
cd fscopy
bun install

# Run locally
bun start -- -f config.ini

# Run tests
bun test

# Type check & lint
bun run type-check
bun run lint
```

## License

[MIT](LICENSE)
