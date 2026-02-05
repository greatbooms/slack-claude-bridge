/**
 * Slack Message Formatter
 *
 * Formats SDK messages for display in Slack.
 * Handles text, code blocks, tool usage, and results.
 */

// Maximum text length for Slack blocks
const MAX_TEXT_LENGTH = 2900;

/**
 * Escape special Slack mrkdwn characters
 */
function escapeSlackText(text: string): string {
    // Escape backticks to prevent breaking code blocks
    return text.replace(/```/g, '` ` `');
}

/**
 * Format assistant text message
 */
export function formatAssistantMessage(content: string): any[] {
    const escaped = escapeSlackText(content);
    const truncated = escaped.length > MAX_TEXT_LENGTH
        ? escaped.slice(0, MAX_TEXT_LENGTH) + '\n\n_(truncated)_'
        : escaped;

    return [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: truncated
            }
        }
    ];
}

/**
 * Format thinking/processing indicator
 */
export function formatThinking(status?: string): any[] {
    return [
        {
            type: "context",
            elements: [{
                type: "mrkdwn",
                text: `_${status || 'Thinking...'}_ :hourglass_flowing_sand:`
            }]
        }
    ];
}

/**
 * Format tool use notification
 */
export function formatToolUse(toolName: string, input?: any): any[] {
    const emoji = getToolEmoji(toolName);
    let inputSummary = '';

    if (input) {
        switch (toolName) {
            case 'Read':
                inputSummary = ` \`${input.file_path || input.path || ''}\``;
                break;
            case 'Write':
            case 'Edit':
                inputSummary = ` \`${input.file_path || input.path || ''}\``;
                break;
            case 'Bash':
                const cmd = input.command || input;
                inputSummary = ` \`${typeof cmd === 'string' ? cmd.slice(0, 50) : '...'}\``;
                break;
            case 'Glob':
                inputSummary = ` \`${input.pattern || input}\``;
                break;
            case 'Grep':
                inputSummary = ` \`${input.pattern}\``;
                break;
        }
    }

    return [
        {
            type: "context",
            elements: [{
                type: "mrkdwn",
                text: `${emoji} *${toolName}*${inputSummary}`
            }]
        }
    ];
}

/**
 * Format error message
 */
export function formatError(error: string): any[] {
    return [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: `❌ *Error*\n\`\`\`${escapeSlackText(error.slice(0, 500))}\`\`\``
            }
        }
    ];
}

/**
 * Get emoji for tool
 */
function getToolEmoji(toolName: string): string {
    const emojis: Record<string, string> = {
        'Read': '📖',
        'Write': '📝',
        'Edit': '✏️',
        'Bash': '💻',
        'Glob': '🔍',
        'Grep': '🔎',
        'WebSearch': '🌐',
        'WebFetch': '📥',
        'Task': '📋',
        'AskUserQuestion': '❓'
    };
    return emojis[toolName] || '🔧';
}

/**
 * Create a simple text message
 */
export function simpleMessage(text: string): any {
    return {
        text,
        blocks: [{
            type: "section",
            text: {
                type: "mrkdwn",
                text
            }
        }]
    };
}
