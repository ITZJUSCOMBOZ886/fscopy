# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in fscopy, please report it responsibly:

1. **Do not** open a public issue
2. Email the maintainers directly or use GitHub's private vulnerability reporting
3. Include:
    - Description of the vulnerability
    - Steps to reproduce
    - Potential impact
    - Any suggested fixes (optional)

We will acknowledge receipt within 48 hours and provide a detailed response within 7 days.

## Security Considerations

### Authentication

fscopy uses Google Application Default Credentials (ADC) for Firebase authentication. Ensure you:

- Never commit credentials or service account keys to version control
- Use `gcloud auth application-default login` for local development
- Use service accounts with minimal required permissions in production

### Data Transfer

- **Dry run mode** is enabled by default (`-d true`) to prevent accidental data modification
- Always verify source and destination projects before running with `-d false`
- Use `--verify` / `-verify-integrity` flag to confirm transfer integrity

### Configuration Files

- Do not store sensitive information in config files
- Add config files containing project IDs to `.gitignore` if needed
- Review config before sharing or committing

### Recommended Permissions

For the service account or user running fscopy:

**Source project:**

- `datastore.entities.list`
- `datastore.entities.get`

**Destination project:**

- `datastore.entities.list`
- `datastore.entities.get`
- `datastore.entities.create`
- `datastore.entities.update`
- `datastore.entities.delete` (if using `--clear` or `--delete-missing`)
