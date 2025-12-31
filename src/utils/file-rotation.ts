import fs from 'node:fs';
import path from 'node:path';

/**
 * Rotate a file if it exceeds maxSize.
 * Creates numbered backups: file.1.ext, file.2.ext, etc.
 *
 * @param filePath - Path to the file to rotate
 * @param maxSize - Maximum file size in bytes (0 = no rotation)
 * @param maxFiles - Maximum number of rotated files to keep (default: 5)
 * @returns true if rotation occurred, false otherwise
 */
export function rotateFileIfNeeded(
    filePath: string,
    maxSize: number,
    maxFiles: number = 5
): boolean {
    if (!filePath || maxSize <= 0) return false;
    if (!fs.existsSync(filePath)) return false;

    const stats = fs.statSync(filePath);
    if (stats.size < maxSize) return false;

    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);

    // Delete oldest backup if at max
    const oldestPath = path.join(dir, `${base}.${maxFiles}${ext}`);
    if (fs.existsSync(oldestPath)) {
        fs.unlinkSync(oldestPath);
    }

    // Shift existing backups: .4 -> .5, .3 -> .4, etc.
    for (let i = maxFiles - 1; i >= 1; i--) {
        const from = path.join(dir, `${base}.${i}${ext}`);
        const to = path.join(dir, `${base}.${i + 1}${ext}`);
        if (fs.existsSync(from)) {
            fs.renameSync(from, to);
        }
    }

    // Rename current to .1
    const backupPath = path.join(dir, `${base}.1${ext}`);
    fs.renameSync(filePath, backupPath);

    return true;
}
