import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { App } from '@slack/bolt';
import { config } from './config';

// Error types for notifications
type ErrorType = 'session_died' | 'tmux_error' | 'slack_error';

// Helper to strip ANSI codes
export const stripAnsi = (str: string): string => {
    if (typeof str !== 'string') return str;
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
};

// Clean terminal output: remove logo/banner, status bar, and shorten long separators
export const cleanTerminalOutput = (output: string): string => {
    const lines = output.split('\n');
    const cleanedLines: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();

        // Skip Claude Code logo/banner
        if (trimmed.includes('▐▛') || trimmed.includes('▝▜') || trimmed.includes('▘▘')) continue;
        if (trimmed.includes('Claude Code v')) continue;
        if (trimmed.match(/^(Opus|Sonnet|Haiku)\s+\d+(\.\d+)?\s*·/)) continue;

        // Skip status bar at bottom
        if (trimmed.match(/^(Opus|Sonnet|Haiku)\s+\d+(\.\d+)?\s*\|/)) continue;
        if (trimmed.startsWith('⏸') || trimmed.startsWith('▶')) continue;
        if (trimmed.includes('/ide for')) continue;

        // Shorten long separator lines (─) to prevent wrapping
        if (/^─{10,}$/.test(trimmed)) {
            cleanedLines.push('────────────────────────');
            continue;
        }

        cleanedLines.push(line);
    }

    return cleanedLines.join('\n').trim();
};

// Error notification function
async function notifyError(
    client: any,
    channelId: string,
    errorType: ErrorType,
    details?: string
): Promise<void> {
    const messages: Record<ErrorType, string> = {
        session_died: '⚠️ Claude 세션이 종료되었습니다.',
        tmux_error: '❌ Tmux 오류가 발생했습니다.',
        slack_error: '⚠️ Slack 메시지 전송에 실패했습니다.'
    };

    try {
        await client.chat.postMessage({
            channel: channelId,
            text: messages[errorType] + (details ? `\n\`${details}\`` : '')
        });
    } catch (err) {
        console.error('Failed to send error notification:', err);
    }
}

// Interface for our Session object
export interface Session {
    sessionName: string;
    lastSnapshot: string;
    pollingInterval: NodeJS.Timeout | null;
    slackTs: string | null;
    msgStartTime: number;
    write: (text: string) => Promise<void>;
    terminate: () => Promise<void>;
    startPolling: () => void;
    updateSlack: (rawOutput: string, client: any, channelId: string) => Promise<void>;
    uploadFullOutput: (client: any, channelId: string) => Promise<void>;
}

const sessions: Record<string, Session> = {}; // userId -> session object

// Helper to run shell command reliably
function runTmuxCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const tmuxCmd = 'tmux';
        const proc = spawn(tmuxCmd, args);
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (d) => stdout += d.toString());
        proc.stderr.on('data', (d) => stderr += d.toString());

        proc.on('close', (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`Tmux error(code ${code}): ${stderr}`));
        });
    });
}

export async function getOrCreateSession(
    userId: string,
    client: any,
    channelId: string,
    initialPath?: string,
    forceNew: boolean = false
): Promise<Session> {
    const sessionName = `claude_${userId}`;

    // Check if session exists in memory
    if (sessions[userId]) {
        if (!forceNew) return sessions[userId];
        await sessions[userId].terminate();
    }

    // Check if tmux session exists in reality (orphan check)
    try {
        await runTmuxCommand(['has-session', '-t', sessionName]);
        if (forceNew) {
            console.log(`Killing existing tmux session: ${sessionName}`);
            await runTmuxCommand(['kill-session', '-t', sessionName]);
        } else {
            console.log(`Re-attaching to existing tmux session: ${sessionName}`);
            const session = createSessionObject(userId, sessionName, client, channelId);
            sessions[userId] = session;
            session.startPolling();
            return session;
        }
    } catch (e) {
        // Session does not exist, safe to create
    }

    let startDir = initialPath || process.cwd();
    if (!fs.existsSync(startDir)) startDir = process.env.HOME || '/';

    try {
        // Create session and start Claude in one command
        await runTmuxCommand([
            'new-session',
            '-d',
            '-s', sessionName,
            '-x', String(config.tmuxWidth),
            '-y', String(config.tmuxHeight),
            '-c', startDir,
            config.claudePath
        ]);
    } catch (err) {
        console.error("Failed to create tmux session:", err);
        await notifyError(client, channelId, 'tmux_error', 'Failed to create tmux session');
        throw err;
    }

    const session = createSessionObject(userId, sessionName, client, channelId);
    sessions[userId] = session;
    session.startPolling();

    return session;
}

// Format uptime string
function formatUptime(startTime: number): string {
    const elapsed = Date.now() - startTime;
    const seconds = Math.floor(elapsed / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}

function createSessionObject(userId: string, sessionName: string, client: any, channelId: string): Session {
    const sessionStartTime = Date.now();

    const session: Session = {
        sessionName,
        lastSnapshot: '',
        pollingInterval: null,
        slackTs: null,
        msgStartTime: 0,

        write: async (text: string) => {
            console.log(`[TMUX] Sending keys to ${sessionName}: ${text}`);

            let keys: string[] = [];
            const lower = text.toLowerCase().trim();

            if (lower === '.' || lower === '' || lower === 'enter') {
                keys = ['Enter'];
            } else if (lower === 'up' || lower === 'k') {
                keys = ['Up'];
            } else if (lower === 'down' || lower === 'j') {
                keys = ['Down'];
            } else if (lower === 'esc') {
                keys = ['Escape'];
            } else if (lower === 'ctrl-c') {
                keys = ['C-c'];
            } else if (lower === 'tab') {
                keys = ['Tab'];
            } else if (lower === 'stab' || lower === 'shift-tab') {
                keys = ['BTab'];
            } else {
                keys = [text, 'Enter'];
            }

            try {
                await runTmuxCommand(['send-keys', '-t', sessionName, ...keys]);
            } catch (err) {
                console.error("Failed to send keys:", err);
                await notifyError(client, channelId, 'tmux_error', 'Failed to send keys to tmux');
            }
        },

        terminate: async () => {
            console.log(`[TMUX] Terminating session ${sessionName}`);
            if (session.pollingInterval) clearInterval(session.pollingInterval);
            try {
                await runTmuxCommand(['kill-session', '-t', sessionName]);
            } catch (e) {
                // Ignore if already dead
            }
            if (sessions[userId]) delete sessions[userId];
        },

        startPolling: function () {
            if (this.pollingInterval) return;

            console.log(`[TMUX] Start polling for ${sessionName}`);
            this.pollingInterval = setInterval(async () => {
                try {
                    const output = await runTmuxCommand([
                        'capture-pane', '-p', '-t', sessionName,
                        '-S', `-${config.tmuxBufferLines}`
                    ]);

                    if (output === this.lastSnapshot) return;

                    this.lastSnapshot = output;
                    this.updateSlack(output, client, channelId);

                } catch (err: any) {
                    console.error("[TMUX POLL ERROR]", err);
                    if (err.message && (err.message.includes('find session') || err.message.includes('no server running'))) {
                        console.log("Session died, stopping polling");
                        if (this.pollingInterval) clearInterval(this.pollingInterval);
                        if (sessions[userId]) delete sessions[userId];
                        await notifyError(client, channelId, 'session_died', sessionName);
                    }
                }
            }, config.pollingIntervalMs);
        },

        updateSlack: async function (rawOutput: string, client: any, channelId: string) {
            const clean = stripAnsi(rawOutput);
            if (!clean.trim()) return;

            // Rotate message every messageRotationMs (create new bubble)
            if (this.slackTs && (Date.now() - this.msgStartTime > config.messageRotationMs)) {
                console.log("Creating new message block due to timeout");
                this.slackTs = null;
            }

            // Clean terminal output (remove logo, long separators, status bar)
            const cleaned = cleanTerminalOutput(clean);

            let displayText = cleaned.length > config.maxMessageLength
                ? "..." + cleaned.slice(-config.maxMessageLength)
                : cleaned;

            // Escape backticks to prevent breaking Slack code blocks
            displayText = displayText.replace(/```/g, '` ` `');

            const uptimeStr = formatUptime(sessionStartTime);

            try {
                const blockPayload = {
                    channel: channelId,
                    text: "Claude Output",
                    blocks: [
                        {
                            type: "header",
                            text: {
                                type: "plain_text",
                                text: "Claude Terminal",
                                emoji: true
                            }
                        },
                        {
                            type: "context",
                            elements: [
                                {
                                    type: "mrkdwn",
                                    text: `*Session:* \`${this.sessionName}\``
                                },
                                {
                                    type: "mrkdwn",
                                    text: `*Uptime:* ${uptimeStr}`
                                }
                            ]
                        },
                        {
                            type: "divider"
                        },
                        {
                            type: "section",
                            text: {
                                type: "mrkdwn",
                                text: "```\n" + displayText + "\n```"
                            }
                        }
                    ]
                };

                if (!this.slackTs) {
                    const res = await client.chat.postMessage(blockPayload);
                    this.slackTs = res.ts as string;
                    this.msgStartTime = Date.now();
                } else {
                    await client.chat.update({
                        ...blockPayload,
                        ts: this.slackTs
                    });
                }
            } catch (err: any) {
                console.error("Slack update failed:", err.message);
                if (err.data && err.data.error === 'message_not_found') {
                    this.slackTs = null;
                } else {
                    await notifyError(client, channelId, 'slack_error', err.message);
                }
            }
        },

        uploadFullOutput: async function (client: any, channelId: string) {
            try {
                // 전체 tmux 히스토리 캡처 (-S - 는 처음부터)
                const raw = await runTmuxCommand([
                    'capture-pane', '-p', '-t', sessionName, '-S', '-'
                ]);
                const cleaned = cleanTerminalOutput(stripAnsi(raw));

                if (!cleaned.trim()) {
                    await client.chat.postMessage({
                        channel: channelId,
                        text: "📄 출력이 비어있습니다."
                    });
                    return;
                }

                await client.files.uploadV2({
                    channel_id: channelId,
                    content: cleaned,
                    filename: `claude_full_${Date.now()}.txt`,
                    initial_comment: `📄 전체 터미널 출력 (${cleaned.length}자)`
                });
            } catch (err: any) {
                console.error("Full output upload failed:", err.message);
                await client.chat.postMessage({
                    channel: channelId,
                    text: `❌ 파일 업로드 실패: ${err.message}`
                });
            }
        }
    };
    return session;
}
