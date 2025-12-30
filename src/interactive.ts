import admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';
import { input, checkbox, confirm } from '@inquirer/prompts';
import type { Config } from './types.js';

export async function runInteractiveMode(config: Config): Promise<Config> {
    console.log('\n' + '='.repeat(60));
    console.log('🔄 FSCOPY - INTERACTIVE MODE');
    console.log('='.repeat(60) + '\n');

    // Prompt for source project if not set
    let sourceProject = config.sourceProject;
    if (!sourceProject) {
        sourceProject = await input({
            message: 'Source Firebase project ID:',
            validate: (value) => value.length > 0 || 'Project ID is required',
        });
    } else {
        console.log(`📤 Source project: ${sourceProject}`);
    }

    // Prompt for destination project if not set
    let destProject = config.destProject;
    if (!destProject) {
        destProject = await input({
            message: 'Destination Firebase project ID:',
            validate: (value) => value.length > 0 || 'Project ID is required',
        });
    } else {
        console.log(`📥 Destination project: ${destProject}`);
    }

    // If source = destination, ask for rename/id modifications
    const renameCollection = config.renameCollection;
    let idPrefix = config.idPrefix;
    let idSuffix = config.idSuffix;

    if (sourceProject === destProject) {
        console.log('\n⚠️  Source and destination are the same project.');
        console.log('   You need to rename collections or modify document IDs to avoid overwriting.\n');

        const modifyIds = await confirm({
            message: 'Add a prefix to document IDs?',
            default: true,
        });

        if (modifyIds) {
            idPrefix = await input({
                message: 'Document ID prefix (e.g., "backup_"):',
                default: 'backup_',
                validate: (value) => value.length > 0 || 'Prefix is required',
            });
        } else {
            // Ask for suffix as alternative
            const useSuffix = await confirm({
                message: 'Add a suffix to document IDs instead?',
                default: true,
            });

            if (useSuffix) {
                idSuffix = await input({
                    message: 'Document ID suffix (e.g., "_backup"):',
                    default: '_backup',
                    validate: (value) => value.length > 0 || 'Suffix is required',
                });
            } else {
                console.log('\n❌ Cannot proceed: source and destination are the same without ID modification.');
                console.log('   This would overwrite your data. Use --rename-collection, --id-prefix, or --id-suffix.\n');
                process.exit(1);
            }
        }
    }

    // Initialize source Firebase to list collections
    console.log('\n📊 Connecting to source project...');

    let tempSourceApp: admin.app.App;
    let sourceDb: Firestore;
    let rootCollections: FirebaseFirestore.CollectionReference[];

    try {
        tempSourceApp = admin.initializeApp(
            {
                credential: admin.credential.applicationDefault(),
                projectId: sourceProject,
            },
            'interactive-source'
        );
        sourceDb = tempSourceApp.firestore();

        // List collections (also tests connectivity)
        rootCollections = await sourceDb.listCollections();
    } catch (error) {
        const err = error as Error & { code?: string };
        console.error('\n❌ Cannot connect to Firebase project:', err.message);

        if (err.message.includes('default credentials') || err.message.includes('credential')) {
            console.error('\n   Run this command to authenticate:');
            console.error('   gcloud auth application-default login\n');
        } else if (err.message.includes('not found') || err.message.includes('NOT_FOUND')) {
            console.error(`\n   Project "${sourceProject}" not found. Check the project ID.\n`);
        } else if (err.message.includes('permission') || err.message.includes('PERMISSION_DENIED')) {
            console.error('\n   You don\'t have permission to access this project\'s Firestore.\n');
        }

        process.exit(1);
    }

    const collectionIds = rootCollections.map((col) => col.id);

    if (collectionIds.length === 0) {
        console.log('\n⚠️  No collections found in source project');
        await tempSourceApp.delete();
        process.exit(0);
    }

    // Count documents in each collection for preview
    console.log('\n📋 Available collections:');
    const collectionInfo: { id: string; count: number }[] = [];
    for (const id of collectionIds) {
        const snapshot = await sourceDb.collection(id).count().get();
        const count = snapshot.data().count;
        collectionInfo.push({ id, count });
        console.log(`   - ${id} (${count} documents)`);
    }

    // Let user select collections
    console.log('');
    const selectedCollections = await checkbox({
        message: 'Select collections to transfer:',
        choices: collectionInfo.map((col) => ({
            name: `${col.id} (${col.count} docs)`,
            value: col.id,
            checked: config.collections.includes(col.id),
        })),
        validate: (value) => value.length > 0 || 'Select at least one collection',
    });

    // Ask about options
    console.log('');
    const includeSubcollections = await confirm({
        message: 'Include subcollections?',
        default: config.includeSubcollections,
    });

    const dryRun = await confirm({
        message: 'Dry run mode (preview without writing)?',
        default: config.dryRun,
    });

    const merge = await confirm({
        message: 'Merge mode (update instead of overwrite)?',
        default: config.merge,
    });

    // Clean up temporary app
    await tempSourceApp.delete();

    // Return updated config
    return {
        ...config,
        sourceProject,
        destProject,
        collections: selectedCollections,
        includeSubcollections,
        dryRun,
        merge,
        renameCollection,
        idPrefix,
        idSuffix,
    };
}
