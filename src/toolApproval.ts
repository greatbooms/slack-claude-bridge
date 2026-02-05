/**
 * Tool Approval Manager
 *
 * Handles tool approval requests via Slack interactive buttons.
 * Users can approve or deny Claude's tool usage requests.
 */

interface PendingApproval {
    resolve: (result: boolean | { denied: true; feedback?: string }) => void;
    toolName: string;
    input: any;
    channelId: string;
    messageTs: string;
    userId: string;
}

// Pending approval requests
const pendingApprovals = new Map<string, PendingApproval>();


/**
 * Format tool input for display
 */
function formatToolInput(toolName: string, input: any): string {
    if (!input) return '';

    switch (toolName) {
        case 'Read':
            return `File: \`${input.file_path || input.path || JSON.stringify(input)}\``;
        case 'Write':
            return `File: \`${input.file_path || input.path}\`\nContent length: ${input.content?.length || 0} chars`;
        case 'Edit':
            return `File: \`${input.file_path || input.path}\``;
        case 'Bash':
            const cmd = input.command || input;
            const cmdStr = typeof cmd === 'string' ? cmd : JSON.stringify(cmd);
            return `Command:\n\`\`\`${cmdStr.slice(0, 500)}${cmdStr.length > 500 ? '...' : ''}\`\`\``;
        case 'Glob':
            return `Pattern: \`${input.pattern || input}\``;
        case 'Grep':
            return `Pattern: \`${input.pattern}\`\nPath: \`${input.path || '.'}\``;
        case 'WebSearch':
            return `Query: \`${input.query || input}\``;
        case 'WebFetch':
            return `URL: \`${input.url || input}\``;
        case 'ExitPlanMode':
            // Plan content is too long, show summary only
            const planPreview = input.plan ? input.plan.slice(0, 300) + '...' : 'No plan content';
            return `Plan preview:\n\`\`\`${planPreview}\`\`\`\n\n_Full plan is in the plan file_`;
        case 'Task':
            return `Agent: \`${input.subagent_type}\`\nDescription: ${input.description}\nPrompt: ${(input.prompt || '').slice(0, 200)}...`;
        default:
            const json = JSON.stringify(input, null, 2);
            return `\`\`\`${json.slice(0, 800)}${json.length > 800 ? '...' : ''}\`\`\``;
    }
}

/**
 * Get tool emoji
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
        'Task': '📋'
    };
    return emojis[toolName] || '🔧';
}

/**
 * Request approval from user via Slack
 */
export async function requestApproval(
    client: any,
    channelId: string,
    userId: string,
    requestId: string,
    toolName: string,
    input: any
): Promise<boolean | { denied: true; feedback?: string }> {
    const emoji = getToolEmoji(toolName);
    const inputDisplay = formatToolInput(toolName, input);

    try {
        // For ExitPlanMode, upload the full plan as a file
        if (toolName === 'ExitPlanMode' && input.plan) {
            try {
                await client.files.uploadV2({
                    channel_id: channelId,
                    content: input.plan,
                    filename: 'plan.md',
                    title: 'Full Plan Content'
                });
            } catch (fileErr: any) {
                console.error('[ToolApproval] Failed to upload plan file:', fileErr.message);
            }
        }

        // Build action buttons
        const actionButtons: any[] = [
            {
                type: "button",
                text: { type: "plain_text", text: "✅ Allow", emoji: true },
                style: "primary",
                action_id: "approve_tool",
                value: requestId
            },
            {
                type: "button",
                text: { type: "plain_text", text: "❌ Deny", emoji: true },
                style: "danger",
                action_id: "deny_tool",
                value: requestId
            }
        ];

        // Add "Deny with Feedback" for ExitPlanMode
        if (toolName === 'ExitPlanMode') {
            actionButtons.push({
                type: "button",
                text: { type: "plain_text", text: "💬 Deny with Feedback", emoji: true },
                action_id: "deny_with_feedback",
                value: requestId
            });
        } else {
            // Add "Always Allow" for other tools
            actionButtons.push({
                type: "button",
                text: { type: "plain_text", text: "🔓 Always Allow", emoji: true },
                action_id: "always_allow_tool",
                value: `${requestId}:${toolName}`
            });
        }

        // Send approval request message with buttons
        const result = await client.chat.postMessage({
            channel: channelId,
            text: `${emoji} Tool approval request: ${toolName}`,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `${emoji} *Tool Approval Request*\n*Tool:* \`${toolName}\``
                    }
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: inputDisplay.length > 2000
                            ? inputDisplay.slice(0, 2000) + '...'
                            : inputDisplay
                    }
                },
                {
                    type: "actions",
                    block_id: `tool_approval_${requestId}`,
                    elements: actionButtons
                }
            ]
        });

        // Wait for user response (no timeout)
        return new Promise<boolean | { denied: true; feedback?: string }>((resolve) => {
            pendingApprovals.set(requestId, {
                resolve: (result: boolean | { denied: true; feedback?: string }) => {
                    pendingApprovals.delete(requestId);
                    resolve(result);
                },
                toolName,
                input,
                channelId,
                messageTs: result.ts as string,
                userId
            });
        });

    } catch (err: any) {
        console.error('[ToolApproval] Failed to send approval request:', err.message);
        return false;
    }
}

/**
 * Handle approval action from Slack button
 */
export function handleApprovalAction(requestId: string, approved: boolean | { denied: true; feedback?: string }): boolean {
    const pending = pendingApprovals.get(requestId);
    if (pending) {
        pending.resolve(approved);
        return true;
    }
    return false;
}

/**
 * Open feedback modal for deny with feedback
 */
export async function openFeedbackModal(
    client: any,
    triggerId: string,
    requestId: string
): Promise<void> {
    try {
        await client.views.open({
            trigger_id: triggerId,
            view: {
                type: "modal",
                callback_id: `feedback_modal_${requestId}`,
                title: {
                    type: "plain_text",
                    text: "Deny with Feedback"
                },
                submit: {
                    type: "plain_text",
                    text: "Submit"
                },
                close: {
                    type: "plain_text",
                    text: "Cancel"
                },
                blocks: [
                    {
                        type: "input",
                        block_id: "feedback_block",
                        label: {
                            type: "plain_text",
                            text: "What changes would you like?"
                        },
                        element: {
                            type: "plain_text_input",
                            action_id: "feedback_input",
                            multiline: true,
                            placeholder: {
                                type: "plain_text",
                                text: "Describe the changes you want to the plan..."
                            }
                        }
                    }
                ],
                private_metadata: requestId
            }
        });
    } catch (err: any) {
        console.error('[ToolApproval] Failed to open feedback modal:', err.message);
    }
}

/**
 * Update approval message after decision
 */
export async function updateApprovalMessage(
    client: any,
    channelId: string,
    messageTs: string,
    status: 'approved' | 'denied' | 'timeout' | 'always_allow'
): Promise<void> {
    const statusText: Record<string, string> = {
        approved: '✅ *Approved*',
        denied: '❌ *Denied*',
        timeout: '⏱️ *Timed out* (auto-denied)',
        always_allow: '🔓 *Always Allowed*'
    };

    try {
        await client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: statusText[status],
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: statusText[status]
                    }
                }
            ]
        });
    } catch (err: any) {
        console.error('[ToolApproval] Failed to update message:', err.message);
    }
}

/**
 * Get pending approval info
 */
export function getPendingApproval(requestId: string): PendingApproval | undefined {
    return pendingApprovals.get(requestId);
}

/**
 * Cancel all pending approvals for a channel
 */
export function cancelUserApprovals(channelId: string): void {
    for (const [requestId, pending] of pendingApprovals) {
        if (pending.channelId === channelId) {
            pending.resolve(false);
            pendingApprovals.delete(requestId);
        }
    }
}

// ===== AskUserQuestion handling =====

interface PendingQuestion {
    resolve: (answer: string) => void;
    question: string;
    options: Array<{ label: string; value: string }>;
    channelId: string;
    messageTs: string;
    userId: string;
}

const pendingQuestions = new Map<string, PendingQuestion>();

/**
 * Request user to answer a question via Slack buttons
 */
export async function requestUserQuestion(
    client: any,
    channelId: string,
    userId: string,
    requestId: string,
    question: string,
    options: Array<{ label: string; value: string }>
): Promise<string> {
    try {
        // Build button elements (max 5 per action block)
        const buttons = options.slice(0, 5).map((opt, idx) => ({
            type: "button",
            text: { type: "plain_text", text: opt.label.slice(0, 75), emoji: true },
            action_id: `question_answer_${idx}`,
            value: `${requestId}:${opt.value}`
        }));

        const result = await client.chat.postMessage({
            channel: channelId,
            text: `Question: ${question}`,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `❓ *Claude is asking:*\n${question}`
                    }
                },
                {
                    type: "actions",
                    block_id: `question_${requestId}`,
                    elements: buttons
                }
            ]
        });

        // Wait for user response (no timeout)
        return new Promise<string>((resolve) => {
            pendingQuestions.set(requestId, {
                resolve: (answer: string) => {
                    pendingQuestions.delete(requestId);
                    resolve(answer);
                },
                question,
                options,
                channelId,
                messageTs: result.ts as string,
                userId
            });
        });

    } catch (err: any) {
        console.error('[Question] Failed to send question:', err.message);
        return options[0]?.value || '';  // Default to first option on error
    }
}

/**
 * Handle question answer from Slack button
 */
export function handleQuestionAnswer(requestId: string, answer: string): boolean {
    const pending = pendingQuestions.get(requestId);
    if (pending) {
        pending.resolve(answer);
        return true;
    }
    return false;
}

/**
 * Update question message after answer
 */
export async function updateQuestionMessage(
    client: any,
    channelId: string,
    messageTs: string,
    status: 'answered' | 'timeout',
    answer?: string
): Promise<void> {
    const statusText = status === 'answered'
        ? `✅ *Answered:* ${answer}`
        : '⏱️ *Timed out* (used default)';

    try {
        await client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: statusText,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: statusText
                    }
                }
            ]
        });
    } catch (err: any) {
        console.error('[Question] Failed to update message:', err.message);
    }
}

/**
 * Get pending question info
 */
export function getPendingQuestion(requestId: string): PendingQuestion | undefined {
    return pendingQuestions.get(requestId);
}
