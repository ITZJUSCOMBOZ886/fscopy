# Contributing to fscopy

Thank you for your interest in contributing to fscopy!

## Development Setup

1. Clone the repository:

```bash
git clone https://github.com/FaZeTitans/fscopy.git
cd fscopy
```

2. Install dependencies:

```bash
bun install
```

3. Run locally:

```bash
bun start -- -f config.ini
```

## Code Style

- Use tabs with size 4 for indentation
- Use single quotes (`'`) over double quotes (`"`)
- Write comments in English
- Run linting before committing:

```bash
bun run lint:fix
bun run format
```

## Testing

Run the test suite before submitting changes:

```bash
bun test
bun run type-check
```

## Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run tests and linting
5. Commit with a descriptive message following conventional commits:
    - `feat:` for new features
    - `fix:` for bug fixes
    - `docs:` for documentation changes
    - `chore:` for maintenance tasks
    - `refactor:` for code refactoring
6. Push to your fork and open a Pull Request

## Reporting Bugs

Open an issue with:

- A clear description of the bug
- Steps to reproduce
- Expected vs actual behavior
- Your environment (OS, Bun version)

## Feature Requests

Open an issue describing:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered
