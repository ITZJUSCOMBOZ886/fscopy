import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function checkCredentialsExist(): { exists: boolean; path: string } {
    // Check for explicit credentials file (non-empty string)
    const envCredPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (envCredPath && envCredPath.length > 0) {
        return { exists: fs.existsSync(envCredPath), path: envCredPath };
    }

    // Check for Application Default Credentials
    const adcPath = path.join(
        os.homedir(),
        '.config',
        'gcloud',
        'application_default_credentials.json'
    );
    return { exists: fs.existsSync(adcPath), path: adcPath };
}

export function ensureCredentials(): void {
    // Skip credentials check in test environment
    if (process.env.FSCOPY_SKIP_CREDENTIALS_CHECK === '1') {
        return;
    }

    const { exists, path: credPath } = checkCredentialsExist();

    if (!exists) {
        console.error('\n❌ Google Cloud credentials not found.');
        console.error(`   Expected at: ${credPath}\n`);
        console.error('   Run this command to authenticate:');
        console.error('   gcloud auth application-default login\n');
        process.exit(1);
    }
}
