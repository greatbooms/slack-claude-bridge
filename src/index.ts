/**
 * Slack-Claude Bridge (SDK Version)
 *
 * A bridge that connects Slack to Claude Agent SDK.
 * Supports interactive tool approval via Slack buttons.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { App } from '@slack/bolt';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { config } from './config';
import { sendMessage, interruptSession, closeSession, clearSession, getSessionInfo, getUserPermissionMode, setUserPermissionMode, getTokenUsage, updateTokenUsage, PermissionMode } from './sdkSession';
import {
    requestApproval,
    handleApprovalAction,
    updateApprovalMessage,
    getPendingApproval,
    cancelUserApprovals,
    requestUserQuestion,
    handleQuestionAnswer,
    updateQuestionMessage,
    getPendingQuestion,
    openFeedbackModal
} from './toolApproval';
import {
    formatAssistantMessage,
    formatThinking,
    formatToolUse,
    formatError,
    simpleMessage
} from './slackFormatter';

// Initialize Slack App
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    signingSecret: process.env.SLACK_SIGNING_SECRET
});

const ALLOWED_USER = process.env.ALLOWED_USER_ID;

// Track active message updates per channel
const activeMessages = new Map<string, {
    ts: string;
    channelId: string;
    content: string;
    lastUpdate: number;
}>();

// Track working directory per channel
const channelWorkingDirs = new Map<string, string>();

// Supported image types
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * Download a file from Slack
 */
async function downloadSlackFile(url: string, token: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const protocol = urlObj.protocol === 'https:' ? https : http;

        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            headers: {
                'Authorization': `Bearer ${token}`
            }
        };

        protocol.get(options, (res) => {
            // Handle redirects
            if (res.statusCode === 302 || res.statusCode === 301) {
                const redirectUrl = res.headers.location;
                if (redirectUrl) {
                    downloadSlackFile(redirectUrl, token).then(resolve).catch(reject);
                    return;
                }
            }

            if (res.statusCode !== 200) {
                reject(new Error(`Failed to download: ${res.statusCode}`));
                return;
            }

            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

/**
 * Get the temp directory for slack images
 */
function getImageTempDir(): string {
    return path.join(os.tmpdir(), 'slack-claude-images');
}

/**
 * Save image to temp directory and return path
 */
async function saveImageToTemp(buffer: Buffer, filename: string): Promise<string> {
    const tempDir = getImageTempDir();
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    const filePath = path.join(tempDir, `${Date.now()}-${filename}`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

/**
 * Delete specific image files
 */
function deleteImages(imagePaths: string[]): void {
    for (const imagePath of imagePaths) {
        try {
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
                console.log(`[Image] Deleted: ${imagePath}`);
            }
        } catch (err: any) {
            console.error(`[Image] Failed to delete ${imagePath}:`, err.message);
        }
    }
}

/**
 * Clean up all images in temp directory
 * Returns the number of files deleted
 */
function cleanupAllImages(): { deleted: number; failed: number; totalSize: number } {
    const tempDir = getImageTempDir();
    let deleted = 0;
    let failed = 0;
    let totalSize = 0;

    if (!fs.existsSync(tempDir)) {
        return { deleted: 0, failed: 0, totalSize: 0 };
    }

    try {
        const files = fs.readdirSync(tempDir);
        for (const file of files) {
            const filePath = path.join(tempDir, file);
            try {
                const stats = fs.statSync(filePath);
                totalSize += stats.size;
                fs.unlinkSync(filePath);
                deleted++;
                console.log(`[Cleanup] Deleted: ${file}`);
            } catch (err: any) {
                failed++;
                console.error(`[Cleanup] Failed to delete ${file}:`, err.message);
            }
        }
    } catch (err: any) {
        console.error(`[Cleanup] Failed to read temp directory:`, err.message);
    }

    return { deleted, failed, totalSize };
}

/**
 * Extract images from Slack message
 */
interface SlackFile {
    id: string;
    name: string;
    mimetype: string;
    url_private: string;
    url_private_download?: string;
}

async function extractImagesFromMessage(msg: any, token: string): Promise<string[]> {
    const imagePaths: string[] = [];

    // Check for files in message
    const files: SlackFile[] = msg.files || [];

    for (const file of files) {
        if (SUPPORTED_IMAGE_TYPES.includes(file.mimetype)) {
            try {
                const downloadUrl = file.url_private_download || file.url_private;
                console.log(`[Image] Downloading: ${file.name}`);

                const buffer = await downloadSlackFile(downloadUrl, token);
                const savedPath = await saveImageToTemp(buffer, file.name);

                console.log(`[Image] Saved to: ${savedPath}`);
                imagePaths.push(savedPath);
            } catch (err: any) {
                console.error(`[Image] Failed to download ${file.name}:`, err.message);
            }
        }
    }

    return imagePaths;
}

/**
 * Get working directory for a channel
 */
function getChannelWorkingDir(channelId: string): string {
    return channelWorkingDirs.get(channelId) || config.defaultProjectPath || process.cwd();
}

/**
 * Set working directory for a channel
 */
function setChannelWorkingDir(channelId: string, dirPath: string): void {
    channelWorkingDirs.set(channelId, dirPath);
    console.log(`[WorkDir] Channel ${channelId} -> ${dirPath}`);
}

/**
 * Clean text from Slack formatting
 */
function cleanSlackText(text: string): string {
    let cleaned = text.trim();

    // Remove code block formatting
    if (cleaned.startsWith('```') && cleaned.endsWith('```')) {
        cleaned = cleaned.slice(3, -3).trim();
    } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.slice(3).trim();
    } else if (cleaned.endsWith('```')) {
        cleaned = cleaned.slice(0, -3).trim();
    }

    // Remove inline code formatting
    if (cleaned.startsWith('`') && cleaned.endsWith('`') && !cleaned.includes('\n')) {
        cleaned = cleaned.slice(1, -1).trim();
    }

    // Remove italic formatting (_text_ -> text)
    cleaned = cleaned.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1');

    // Remove bold formatting (*text* -> text)
    cleaned = cleaned.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1');

    return cleaned;
}

// Slack message limits
const SLACK_TEXT_LIMIT = 3000;  // Block text limit

/**
 * Update or create Slack message
 * - During streaming: update the same message
 * - New query: always create new message
 * - If content is too long: upload as file
 */
async function updateSlackMessage(
    client: any,
    channelId: string,
    messageTs: string | null,
    content: string
): Promise<string> {
    // If content is too long, upload as file instead
    if (content.length > SLACK_TEXT_LIMIT) {
        // Delete existing message if any
        if (messageTs) {
            try {
                await client.chat.delete({ channel: channelId, ts: messageTs });
            } catch (e) {
                // Ignore deletion errors
            }
        }

        // Upload full content as file
        try {
            await client.files.uploadV2({
                channel_id: channelId,
                content: content,
                filename: 'response.md',
                title: 'Claude Response'
            });
        } catch (fileErr: any) {
            console.error('[Slack] Failed to upload file:', fileErr.message);
        }

        // Post a short summary message
        const summary = content.slice(0, 500) + '...\n\n_(Full response uploaded as file)_';
        const result = await client.chat.postMessage({
            channel: channelId,
            text: summary,
            blocks: formatAssistantMessage(summary)
        });
        return result.ts as string;
    }

    // If no existing message, create new one
    if (!messageTs) {
        const result = await client.chat.postMessage({
            channel: channelId,
            text: content,
            blocks: formatAssistantMessage(content)
        });
        return result.ts as string;
    }

    // Update existing message (during streaming)
    try {
        await client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: content,
            blocks: formatAssistantMessage(content)
        });
        return messageTs;
    } catch (err: any) {
        // If update fails due to msg_too_long, upload as file
        if (err.data?.error === 'msg_too_long') {
            try {
                await client.files.uploadV2({
                    channel_id: channelId,
                    content: content,
                    filename: 'response.md',
                    title: 'Claude Response'
                });
                // Update message to indicate file was uploaded
                const summary = content.slice(0, 500) + '...\n\n_(Full response uploaded as file)_';
                await client.chat.update({
                    channel: channelId,
                    ts: messageTs,
                    text: summary,
                    blocks: formatAssistantMessage(summary)
                });
            } catch (fileErr: any) {
                console.error('[Slack] Failed to upload file:', fileErr.message);
            }
            return messageTs;
        }
        // If update fails due to message_not_found, create new message
        if (err.data?.error === 'message_not_found') {
            const result = await client.chat.postMessage({
                channel: channelId,
                text: content,
                blocks: formatAssistantMessage(content)
            });
            return result.ts as string;
        }
        throw err;
    }
}

// ===== Message Handler =====
app.message(async ({ message, client }) => {
    const msg = message as any;

    // Ignore bot messages and messages without user
    if (!msg.user || msg.subtype === 'bot_message') return;

    // Check user authorization
    if (ALLOWED_USER && msg.user !== ALLOWED_USER) {
        console.log(`[Auth] Unauthorized access attempt from ${msg.user}`);
        return;
    }

    const channelId = msg.channel;
    const userId = msg.user;

    // Extract images from message
    const imagePaths = await extractImagesFromMessage(msg, process.env.SLACK_BOT_TOKEN || '');

    // Build message text
    let text = msg.text ? cleanSlackText(msg.text) : '';

    // If there are images but no text, add a default prompt
    if (imagePaths.length > 0 && !text) {
        text = 'Please analyze this image.';
    }

    // Add image file paths to the message
    if (imagePaths.length > 0) {
        const imageInstructions = imagePaths.map(p => `[Image: ${p}]`).join('\n');
        text = `${text}\n\n${imageInstructions}\n\nPlease use the Read tool to view the image file(s) above.`;
    }

    if (!text) return;

    // Debug log
    console.log(`[Message] User: ${userId}, Text: "${text}", Images: ${imagePaths.length}`);

    // ===== Handle Commands =====

    // help - Show available commands
    if (text === 'help') {
        await client.chat.postMessage({
            channel: channelId,
            ...simpleMessage(
                `*Available Commands*\n\n` +
                `• \`cd [path]\` - Show/change working directory\n` +
                `• \`status\` - Show session status\n` +
                `• \`usage\` - Show token usage\n` +
                `• \`mode [mode]\` - Show/change permission mode\n` +
                `• \`abort\` - Interrupt current operation\n` +
                `• \`exit\` - Terminate session\n` +
                `• \`clear\` - Clear message tracking\n` +
                `• \`cleanup\` - Clean up temporary images\n` +
                `• \`help\` - Show this help\n\n` +
                `*Permission Modes*\n` +
                `• \`default\` - Ask for tool approval\n` +
                `• \`accept\` - Auto-approve file edits\n` +
                `• \`bypass\` - Auto-approve all tools`
            )
        });
        return;
    }

    // cd - Change directory
    if (text.startsWith('cd ') || text.startsWith('cd/') || text === 'cd') {
        // Extract path after 'cd' command
        let targetPath = text.replace(/^cd\s*/, '').trim();

        // Show current directory if no path provided
        if (!targetPath) {
            const cwd = getChannelWorkingDir(channelId);
            await client.chat.postMessage({
                channel: channelId,
                ...simpleMessage(`📂 Current working directory: \`${cwd}\``)
            });
            return;
        }

        // Expand ~
        if (targetPath.startsWith('~/') && process.env.HOME) {
            targetPath = path.join(process.env.HOME, targetPath.slice(2));
        } else if (targetPath === '~' && process.env.HOME) {
            targetPath = process.env.HOME;
        }

        if (!fs.existsSync(targetPath)) {
            await client.chat.postMessage({
                channel: channelId,
                ...simpleMessage(`❌ Directory not found: \`${targetPath}\``)
            });
            return;
        }

        // Clear existing session and set new path for this channel
        clearSession(channelId);
        setChannelWorkingDir(channelId, targetPath);

        await client.chat.postMessage({
            channel: channelId,
            ...simpleMessage(`📂 Working directory changed to: \`${targetPath}\``)
        });
        return;
    }

    // exit - Terminate session (full close)
    if (text === 'exit') {
        closeSession(channelId);
        clearSession(channelId);
        activeMessages.delete(channelId);
        cancelUserApprovals(channelId);

        await client.chat.postMessage({
            channel: channelId,
            ...simpleMessage('🛑 Session terminated.')
        });
        return;
    }

    // abort - Interrupt current operation (immediate stop)
    if (text === 'abort') {
        const interrupted = interruptSession(channelId);
        cancelUserApprovals(channelId);

        await client.chat.postMessage({
            channel: channelId,
            ...simpleMessage(interrupted ? '⚠️ Operation interrupted.' : '⚠️ No active operation to interrupt.')
        });
        return;
    }

    // status - Show session status
    if (text === 'status') {
        const info = getSessionInfo(channelId);
        const cwd = getChannelWorkingDir(channelId);
        const currentMode = getUserPermissionMode(channelId);
        const modeLabels: Record<PermissionMode, string> = {
            'default': '🔒 default',
            'acceptEdits': '📝 acceptEdits',
            'bypassPermissions': '⚡ bypassPermissions'
        };

        const statusText = info
            ? `📊 *Session Status*\nSession ID: \`${info.sessionId || 'none'}\`\nActive: ${info.isActive ? 'Yes' : 'No'}\nWorking dir: \`${cwd}\`\nMode: ${modeLabels[currentMode]}`
            : `📊 No active session\nWorking dir: \`${cwd}\`\nMode: ${modeLabels[currentMode]}`;

        await client.chat.postMessage({
            channel: channelId,
            ...simpleMessage(statusText)
        });
        return;
    }

    // usage - Show token usage
    if (text === 'usage') {
        console.log(`[Usage] Checking token usage for channel: ${channelId}`);
        const tokenUsage = getTokenUsage(channelId);
        console.log(`[Usage] Token usage result:`, tokenUsage);

        if (!tokenUsage || (tokenUsage.inputTokens === 0 && tokenUsage.outputTokens === 0)) {
            await client.chat.postMessage({
                channel: channelId,
                ...simpleMessage('📈 No token usage recorded yet.')
            });
            return;
        }

        const totalTokens = tokenUsage.inputTokens + tokenUsage.outputTokens;
        const cacheTokens = tokenUsage.cacheReadTokens + tokenUsage.cacheWriteTokens;

        let usageText = `📈 *Token Usage (This Session)*\n\n` +
            `• Input: \`${tokenUsage.inputTokens.toLocaleString()}\` tokens\n` +
            `• Output: \`${tokenUsage.outputTokens.toLocaleString()}\` tokens\n` +
            `• *Total: \`${totalTokens.toLocaleString()}\` tokens*`;

        if (cacheTokens > 0) {
            usageText += `\n\n*Cache:*\n` +
                `• Read: \`${tokenUsage.cacheReadTokens.toLocaleString()}\` tokens\n` +
                `• Write: \`${tokenUsage.cacheWriteTokens.toLocaleString()}\` tokens`;
        }

        await client.chat.postMessage({
            channel: channelId,
            ...simpleMessage(usageText)
        });
        return;
    }

    // clear - Clear message tracking
    if (text === 'clear') {
        activeMessages.delete(userId);
        await client.chat.postMessage({
            channel: channelId,
            ...simpleMessage('🧹 Message tracking cleared.')
        });
        return;
    }

    // cleanup - Clean up all temporary images
    if (text === 'cleanup') {
        const result = cleanupAllImages();
        const sizeMB = (result.totalSize / (1024 * 1024)).toFixed(2);
        const sizeKB = (result.totalSize / 1024).toFixed(1);
        const sizeStr = result.totalSize >= 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;

        const message = result.deleted > 0
            ? `🧹 Image cleanup complete!\n• Deleted: ${result.deleted} file(s)\n• Freed: ${sizeStr}` + (result.failed > 0 ? `\n• Failed: ${result.failed} file(s)` : '')
            : '🧹 No temporary images to clean up.';

        await client.chat.postMessage({
            channel: channelId,
            ...simpleMessage(message)
        });
        return;
    }

    // mode - Change permission mode
    if (text === 'mode' || text.startsWith('mode ')) {
        const modeArg = text.replace(/^mode\s*/, '').trim().toLowerCase();
        const currentMode = getUserPermissionMode(channelId);

        // Show current mode if no argument
        if (!modeArg) {
            const modeDescriptions: Record<PermissionMode, string> = {
                'default': '🔒 Default - Ask for tool approval',
                'acceptEdits': '📝 Accept Edits - Auto-approve file edits',
                'bypassPermissions': '⚡ Bypass - Auto-approve all tools'
            };
            await client.chat.postMessage({
                channel: channelId,
                ...simpleMessage(
                    `*Current Mode:* ${modeDescriptions[currentMode]}\n\n` +
                    `*Available modes:*\n` +
                    `• \`/mode default\` - Ask for tool approval\n` +
                    `• \`/mode accept\` - Auto-approve file edits\n` +
                    `• \`/mode bypass\` - Auto-approve all tools (dangerous!)`
                )
            });
            return;
        }

        // Parse mode argument
        let newMode: PermissionMode;
        if (modeArg === 'default' || modeArg === 'normal') {
            newMode = 'default';
        } else if (modeArg === 'accept' || modeArg === 'acceptedits' || modeArg === 'edit' || modeArg === 'edits') {
            newMode = 'acceptEdits';
        } else if (modeArg === 'bypass' || modeArg === 'bypasspermissions' || modeArg === 'auto' || modeArg === 'yolo') {
            newMode = 'bypassPermissions';
        } else {
            await client.chat.postMessage({
                channel: channelId,
                ...simpleMessage(`❌ Unknown mode: \`${modeArg}\`\n\nUse: \`default\`, \`accept\`, or \`bypass\``)
            });
            return;
        }

        setUserPermissionMode(channelId, newMode);

        const modeEmoji: Record<PermissionMode, string> = {
            'default': '🔒',
            'acceptEdits': '📝',
            'bypassPermissions': '⚡'
        };

        await client.chat.postMessage({
            channel: channelId,
            ...simpleMessage(`${modeEmoji[newMode]} Permission mode changed to: \`${newMode}\``)
        });
        return;
    }

    // ===== Send message to Claude =====

    // Show thinking indicator
    const thinkingResult = await client.chat.postMessage({
        channel: channelId,
        text: 'Thinking...',
        blocks: formatThinking()
    });
    const thinkingTs = thinkingResult.ts as string;

    let accumulatedContent = '';
    let currentMessageTs: string | null = null;
    let lastToolName: string | null = null;

    const cwd = getChannelWorkingDir(channelId);
    console.log(`[SDK] Sending message to channel ${channelId} with cwd: ${cwd}`);

    try {
        await sendMessage(channelId, text, {
            cwd: cwd,

            onMessage: async (sdkMsg) => {
                try {
                    // Debug: log all message types
                    console.log(`[SDK] Message type: ${sdkMsg.type}, subtype: ${sdkMsg.subtype || 'none'}`);

                    // Handle different message types
                    if (sdkMsg.type === 'assistant' && sdkMsg.message?.content) {
                        // Extract text content
                        for (const block of sdkMsg.message.content) {
                            if (block.type === 'text') {
                                accumulatedContent += block.text;
                            } else if (block.type === 'tool_use') {
                                lastToolName = block.name;
                                // Show tool use indicator
                                await client.chat.postMessage({
                                    channel: channelId,
                                    text: `Using tool: ${block.name}`,
                                    blocks: formatToolUse(block.name, block.input)
                                });
                            }
                        }

                        // Update message if we have content
                        if (accumulatedContent.trim()) {
                            // Delete thinking indicator on first content
                            if (!currentMessageTs) {
                                try {
                                    await client.chat.delete({
                                        channel: channelId,
                                        ts: thinkingTs
                                    });
                                } catch (e) {
                                    // Ignore deletion errors
                                }
                            }

                            currentMessageTs = await updateSlackMessage(
                                client,
                                channelId,
                                currentMessageTs,  // Pass current message ts for streaming updates
                                accumulatedContent
                            );
                        }
                    } else if (sdkMsg.type === 'result') {
                        // Final result with token usage
                        console.log(`[SDK] Result message:`, JSON.stringify(sdkMsg, null, 2).slice(0, 500));
                        const usage = sdkMsg.modelUsage;
                        if (usage) {
                            // Aggregate usage from all models
                            let totalInput = 0;
                            let totalOutput = 0;
                            let totalCacheRead = 0;
                            let totalCacheWrite = 0;

                            for (const modelKey of Object.keys(usage)) {
                                const modelData = usage[modelKey];
                                if (modelData) {
                                    totalInput += modelData.inputTokens || 0;
                                    totalOutput += modelData.outputTokens || 0;
                                    totalCacheRead += modelData.cacheReadInputTokens || 0;
                                    totalCacheWrite += modelData.cacheCreationInputTokens || 0;
                                }
                            }

                            // Update session token usage
                            updateTokenUsage(channelId, {
                                inputTokens: totalInput,
                                outputTokens: totalOutput,
                                cacheReadTokens: totalCacheRead,
                                cacheWriteTokens: totalCacheWrite
                            });

                            console.log(`[SDK] Tokens - Input: ${totalInput}, Output: ${totalOutput}, Cache: ${totalCacheRead}/${totalCacheWrite}`);
                        }
                    }
                } catch (err: any) {
                    console.error('[Slack] Message update error:', err.message);
                }
            },

            onToolApproval: async (request) => {
                // Auto-approve safe tools
                if (config.autoApproveTools.includes(request.toolName)) {
                    console.log(`[SDK] Auto-approved tool: ${request.toolName}`);
                    return true;
                }

                // Request user approval via Slack buttons
                return await requestApproval(
                    client,
                    channelId,
                    userId,
                    request.requestId,
                    request.toolName,
                    request.input
                );
            },

            onUserQuestion: async (request) => {
                // Convert SDK options format to our format
                const options = request.options.map(opt => ({
                    label: opt.label,
                    value: opt.value
                }));

                return await requestUserQuestion(
                    client,
                    channelId,
                    userId,
                    request.requestId,
                    request.question,
                    options
                );
            },

            onComplete: async (sessionId) => {
                console.log(`[SDK] Query completed. Session: ${sessionId}`);

                // Auto-delete downloaded images after use
                if (imagePaths.length > 0) {
                    deleteImages(imagePaths);
                    console.log(`[Image] Auto-deleted ${imagePaths.length} image(s) after completion`);
                }

                // Delete thinking indicator if no content was sent
                if (!currentMessageTs) {
                    try {
                        await client.chat.delete({
                            channel: channelId,
                            ts: thinkingTs
                        });
                    } catch (e) {
                        // Ignore
                    }
                }
            },

            onError: async (err) => {
                console.error('[SDK] Error:', err.message);

                // Auto-delete downloaded images on error
                if (imagePaths.length > 0) {
                    deleteImages(imagePaths);
                    console.log(`[Image] Auto-deleted ${imagePaths.length} image(s) after error`);
                }

                // Delete thinking indicator
                try {
                    await client.chat.delete({
                        channel: channelId,
                        ts: thinkingTs
                    });
                } catch (e) {
                    // Ignore
                }

                await client.chat.postMessage({
                    channel: channelId,
                    text: `Error: ${err.message}`,
                    blocks: formatError(err.message)
                });
            }
        });
    } catch (err: any) {
        console.error('[SDK] Unhandled error:', err);
        await client.chat.postMessage({
            channel: channelId,
            text: `Error: ${err.message}`,
            blocks: formatError(err.message)
        });
    }
});

// ===== Button Action Handlers =====

app.action('approve_tool', async ({ ack, body, client }) => {
    await ack();

    const actionBody = body as any;
    const requestId = actionBody.actions[0].value;
    const pending = getPendingApproval(requestId);

    handleApprovalAction(requestId, true);

    if (pending) {
        await updateApprovalMessage(
            client,
            pending.channelId,
            pending.messageTs,
            'approved'
        );
    }
});

app.action('deny_tool', async ({ ack, body, client }) => {
    await ack();

    const actionBody = body as any;
    const requestId = actionBody.actions[0].value;
    const pending = getPendingApproval(requestId);

    handleApprovalAction(requestId, false);

    if (pending) {
        await updateApprovalMessage(
            client,
            pending.channelId,
            pending.messageTs,
            'denied'
        );
    }
});

app.action('always_allow_tool', async ({ ack, body, client }) => {
    await ack();

    const actionBody = body as any;
    const value = actionBody.actions[0].value;
    const [requestId, toolName] = value.split(':');
    const pending = getPendingApproval(requestId);

    // Add to auto-approve list for this session
    if (toolName && !config.autoApproveTools.includes(toolName)) {
        config.autoApproveTools.push(toolName);
        console.log(`[Config] Added ${toolName} to auto-approve list`);
    }

    handleApprovalAction(requestId, true);

    if (pending) {
        await updateApprovalMessage(
            client,
            pending.channelId,
            pending.messageTs,
            'always_allow'
        );
    }
});

app.action('deny_with_feedback', async ({ ack, body, client }) => {
    await ack();

    const actionBody = body as any;
    const requestId = actionBody.actions[0].value;
    const triggerId = actionBody.trigger_id;

    // Open feedback modal
    await openFeedbackModal(client, triggerId, requestId);
});

// Handle feedback modal submission
app.view(/^feedback_modal_/, async ({ ack, view, client }) => {
    await ack();

    const requestId = view.private_metadata;
    const feedback = view.state.values.feedback_block?.feedback_input?.value || '';
    const pending = getPendingApproval(requestId);

    console.log(`[Feedback] Request ${requestId}: ${feedback}`);

    // Deny with feedback
    handleApprovalAction(requestId, { denied: true, feedback });

    if (pending) {
        await updateApprovalMessage(
            client,
            pending.channelId,
            pending.messageTs,
            'denied'
        );

        // Send feedback as a follow-up message
        if (feedback) {
            await client.chat.postMessage({
                channel: pending.channelId,
                text: `💬 *Feedback:* ${feedback}`
            });
        }
    }
});

// ===== Question Answer Handlers =====
// Handle question_answer_0 through question_answer_4 (max 5 options)
for (let i = 0; i < 5; i++) {
    app.action(`question_answer_${i}`, async ({ ack, body, client }) => {
        await ack();

        const actionBody = body as any;
        const value = actionBody.actions[0].value;
        const [requestId, answer] = value.split(':');
        const pending = getPendingQuestion(requestId);

        handleQuestionAnswer(requestId, answer);

        if (pending) {
            // Find the label for this answer
            const option = pending.options.find(opt => opt.value === answer);
            const answerLabel = option?.label || answer;

            await updateQuestionMessage(
                client,
                pending.channelId,
                pending.messageTs,
                'answered',
                answerLabel
            );
        }
    });
}

// ===== Start App =====

(async () => {
    await app.start();
    console.log('⚡️ Slack-Claude Bridge (SDK Mode) is running!');
    console.log(`📂 Default project path: ${config.defaultProjectPath}`);
    console.log(`🔧 Auto-approve tools: ${config.autoApproveTools.join(', ')}`);
})();
