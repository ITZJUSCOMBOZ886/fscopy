import fs from 'node:fs';
import path from 'node:path';
import { getFileFormat } from './parser.js';
import { iniTemplate, jsonTemplate } from './defaults.js';

export function generateConfigFile(outputPath: string): boolean {
    const filePath = path.resolve(outputPath);
    const format = getFileFormat(filePath);

    if (fs.existsSync(filePath)) {
        console.error(`❌ File already exists: ${filePath}`);
        console.error('   Use a different filename or delete the existing file.');
        process.exitCode = 1;
        return false;
    }

    const content = format === 'json' ? JSON.stringify(jsonTemplate, null, 4) : iniTemplate;

    fs.writeFileSync(filePath, content, 'utf-8');

    console.log(`✓ Config template created: ${filePath}`);
    console.log('');
    console.log('Edit the file to configure your transfer, then run:');
    console.log(`  fscopy -f ${outputPath}`);

    return true;
}
