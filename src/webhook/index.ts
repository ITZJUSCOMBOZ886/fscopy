import type { Stats } from '../types.js';
import type { Logger } from '../utils/logger.js';

export interface WebhookPayload {
    source: string;
    destination: string;
    collections: string[];
    stats: Stats;
    duration: number;
    dryRun: boolean;
    success: boolean;
    error?: string;
}

export function detectWebhookType(url: string): 'slack' | 'discord' | 'custom' {
    if (url.includes('hooks.slack.com')) {
        return 'slack';
    }
    if (url.includes('discord.com/api/webhooks')) {
        return 'discord';
    }
    return 'custom';
}

export function formatSlackPayload(payload: WebhookPayload): Record<string, unknown> {
    const status = payload.success ? ':white_check_mark: Success' : ':x: Failed';
    const mode = payload.dryRun ? ' (DRY RUN)' : '';

    const fields = [
        { title: 'Source', value: payload.source, short: true },
        { title: 'Destination', value: payload.destination, short: true },
        { title: 'Collections', value: payload.collections.join(', '), short: false },
        { title: 'Transferred', value: String(payload.stats.documentsTransferred), short: true },
        { title: 'Deleted', value: String(payload.stats.documentsDeleted), short: true },
        { title: 'Errors', value: String(payload.stats.errors), short: true },
        { title: 'Duration', value: `${payload.duration}s`, short: true },
    ];

    if (payload.error) {
        fields.push({ title: 'Error', value: payload.error, short: false });
    }

    return {
        attachments: [
            {
                color: payload.success ? '#36a64f' : '#ff0000',
                title: `fscopy Transfer${mode}`,
                text: status,
                fields,
                footer: 'fscopy',
                ts: Math.floor(Date.now() / 1000),
            },
        ],
    };
}

export function formatDiscordPayload(payload: WebhookPayload): Record<string, unknown> {
    const status = payload.success ? '✅ Success' : '❌ Failed';
    const mode = payload.dryRun ? ' (DRY RUN)' : '';
    const color = payload.success ? 0x36a64f : 0xff0000;

    const fields = [
        { name: 'Source', value: payload.source, inline: true },
        { name: 'Destination', value: payload.destination, inline: true },
        { name: 'Collections', value: payload.collections.join(', '), inline: false },
        { name: 'Transferred', value: String(payload.stats.documentsTransferred), inline: true },
        { name: 'Deleted', value: String(payload.stats.documentsDeleted), inline: true },
        { name: 'Errors', value: String(payload.stats.errors), inline: true },
        { name: 'Duration', value: `${payload.duration}s`, inline: true },
    ];

    if (payload.error) {
        fields.push({ name: 'Error', value: payload.error, inline: false });
    }

    return {
        embeds: [
            {
                title: `fscopy Transfer${mode}`,
                description: status,
                color,
                fields,
                footer: { text: 'fscopy' },
                timestamp: new Date().toISOString(),
            },
        ],
    };
}

export async function sendWebhook(
    webhookUrl: string,
    payload: WebhookPayload,
    logger: Logger
): Promise<void> {
    const webhookType = detectWebhookType(webhookUrl);

    let body: Record<string, unknown>;
    switch (webhookType) {
        case 'slack':
            body = formatSlackPayload(payload);
            break;
        case 'discord':
            body = formatDiscordPayload(payload);
            break;
        default:
            body = payload as unknown as Record<string, unknown>;
    }

    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        logger.info(`Webhook sent successfully (${webhookType})`, { url: webhookUrl });
        console.log(`📤 Webhook notification sent (${webhookType})`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to send webhook: ${message}`, { url: webhookUrl });
        console.error(`⚠️  Failed to send webhook: ${message}`);
    }
}
