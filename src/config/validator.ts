import type { Config } from '../types.js';

export function validateConfig(config: Config): string[] {
    const errors: string[] = [];

    if (!config.sourceProject) {
        errors.push('Source project is required (--source-project or in config file)');
    }
    if (!config.destProject) {
        errors.push('Destination project is required (--dest-project or in config file)');
    }
    if (config.sourceProject && config.destProject && config.sourceProject === config.destProject) {
        // Same project is allowed only if we're renaming collections or modifying IDs
        const hasRenamedCollections = Object.keys(config.renameCollection).length > 0;
        const hasIdModification = config.idPrefix !== null || config.idSuffix !== null;

        if (!hasRenamedCollections && !hasIdModification) {
            errors.push(
                'Source and destination projects are the same. ' +
                    'Use --rename-collection or --id-prefix/--id-suffix to avoid overwriting data.'
            );
        }
    }
    if (!config.collections || config.collections.length === 0) {
        errors.push('At least one collection is required (-c or --collections)');
    }

    return errors;
}
