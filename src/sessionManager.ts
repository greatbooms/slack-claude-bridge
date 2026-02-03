import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { App } from '@slack/bolt'; // Assuming @slack/bolt is used for the client type

// Helper to strip ANSI codes
const stripAnsi = (str: string): string => {
    if (typeof str !== 'string') return str;
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
};

// Use process.env.CLAUDE_PATH if available, otherwise a default path
const CLAUDE_PATH = process.env.CLAUDE_PATH || '/usr/local/bin/claude'; // Defaulting to a common install path

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
            else reject(new Error(`Tmux error(code ${code}): ${stderr} `));
        });
    });
}

export async function getOrCreateSession(
    userId: string,
    client: any, // or specific Slack Client type, e.g., WebClient from @slack/web-api
    channelId: string,
    initialPath?: string,
    forceNew: boolean = false
): Promise<Session> {
    const sessionName = `claude_${userId} `;

    // Check if session exists in memory
    if (sessions[userId]) {
        if (!forceNew) return sessions[userId];
        await sessions[userId].terminate();
    }

    // Check if tmux session exists in reality (orphan check)
    try {
        await runTmuxCommand(['has-session', '-t', sessionName]);
        if (forceNew) {
            console.log(`Killing existing tmux session: ${sessionName} `);
            await runTmuxCommand(['kill-session', '-t', sessionName]);
        } else {
            console.log(`Re - attaching to existing tmux session: ${sessionName} `);
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

    console.log(`Creating new tmux session: ${sessionName} in ${startDir} `);

    try {
        await runTmuxCommand([
            'new-session',
            '-d',
            '-s', sessionName,
            '-c', startDir,
            CLAUDE_PATH
        ]);
    } catch (err) {
        console.error("Failed to create tmux session:", err);
        throw err;
    }

    const session = createSessionObject(userId, sessionName, client, channelId);
    sessions[userId] = session;
    session.startPolling();

    return session;
}

function createSessionObject(userId: string, sessionName: string, client: any, channelId: string): Session {
    const session: Session = {
        sessionName,
        lastSnapshot: '',
        pollingInterval: null,
        slackTs: null,
        msgStartTime: 0,

        write: async (text: string) => {
            console.log(`[TMUX] Sending keys to ${sessionName}: ${text} `);

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
                // Optional: When user types distinct command, force new message block immediately?
                // session.slackTs = null;
            } catch (err) {
                console.error("Failed to send keys:", err);
            }
        },

        terminate: async () => {
            console.log(`[TMUX] Terminating session ${sessionName} `);
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
                    const output = await runTmuxCommand(['capture-pane', '-p', '-t', sessionName, '-S', '-50']);

                    if (output === this.lastSnapshot) return;

                    this.lastSnapshot = output;
                    // Use 'this' or 'session' variable?
                    // Safe to use 'this' here as it's a regular function method
                    this.updateSlack(output, client, channelId);

                } catch (err: any) {
                    if (err.message && err.message.includes('find session')) {
                        console.log("Session died, stopping polling");
                        if (this.pollingInterval) clearInterval(this.pollingInterval);
                        if (sessions[userId]) delete sessions[userId];
                    }
                }
            }, 1000);
        },

        updateSlack: async function (rawOutput: string, client: any, channelId: string) {
            const clean = stripAnsi(rawOutput);
            if (!clean.trim()) return;

            // Rotate message every 60 seconds (create new bubble)
            if (this.slackTs && (Date.now() - this.msgStartTime > 60000)) {
                console.log("Creating new message block due to timeout");
                this.slackTs = null;
            }

            // Trim to last 3000 chars for Slack limit
            const displayText = clean.length > 2500
                ? "..." + clean.slice(-2500)
                : clean;

            try {
                const blockPayload = {
                    channel: channelId,
                    text: "Terminal Output",
                    blocks: [
                        {
                            type: "section",
                            text: {
                                type: "mrkdwn",
                                text: `* Claude Desktop(via Tmux) *\nSession: \`${this.sessionName}\``
                            }
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
                    this.msgStartTime = Date.now(); // Reset timer
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
                }
            }
        }
    };
    return session;
}


