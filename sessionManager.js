const { exec, spawn } = require('child_process');
const fs = require('fs');
const stripAnsi = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
};

const sessions = {}; // userId -> session object
const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';

// Helper to run shell command reliably
function runTmuxCommand(args) {
    return new Promise((resolve, reject) => {
        // Use full path to tmux just in case, though brew install usually puts it in path
        const tmuxCmd = 'tmux';
        const proc = spawn(tmuxCmd, args);
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);

        proc.on('close', (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`Tmux error (code ${code}): ${stderr}`));
        });
    });
}

async function getOrCreateSession(userId, client, channelId, initialPath, forceNew = false) {
    const sessionName = `claude_${userId}`;

    // Check if session exists in our memory
    if (sessions[userId]) {
        if (!forceNew) return sessions[userId];
        // If force new, kill existing
        await sessions[userId].terminate();
    }

    // Check if tmux session exists in reality (orphan check)
    try {
        await runTmuxCommand(['has-session', '-t', sessionName]);
        // If it exists but we forced new, kill it
        if (forceNew) {
            console.log(`Killing existing tmux session: ${sessionName}`);
            await runTmuxCommand(['kill-session', '-t', sessionName]);
        } else {
            console.log(`Re-attaching to existing tmux session: ${sessionName}`);
            // It exists, so we just attach our logic to it
            const session = createSessionObject(userId, sessionName, client, channelId);
            sessions[userId] = session;
            session.startPolling();
            return session;
        }
    } catch (e) {
        // Session does not exist, safe to create
    }

    let startDir = initialPath || process.cwd();

    if (!fs.existsSync(startDir)) {
        startDir = process.env.HOME;
    } console.log(`Creating new tmux session: ${sessionName} in ${startDir}`);

    // Create new tmux session running Claude
    // -d: detached
    // -s: session name
    // command: claude
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

function createSessionObject(userId, sessionName, client, channelId) {
    return {
        sessionName,
        lastSnapshot: '',
        pollingInterval: null,
        slackTs: null,
        msgStartTime: 0, // Track when the current message block started

        write: async (text) => {
            console.log(`[TMUX] Sending keys to ${sessionName}: ${text}`);

            // Key Mapping for Interactive Control
            let keys = [];
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
                // Normal text input
                keys = [text, 'Enter'];
            }

            try {
                // Pass individual keys/args to send-keys
                // We spread the keys array into the command args
                await runTmuxCommand(['send-keys', '-t', sessionName, ...keys]);

                // Optional: When user types distinct command, force new message block immediately?
                // this.slackTs = null; 
            } catch (err) {
                console.error("Failed to send keys:", err);
            }
        },

        terminate: async () => {
            console.log(`[TMUX] Terminating session ${sessionName}`);
            if (this.pollingInterval) clearInterval(this.pollingInterval);
            try {
                await runTmuxCommand(['kill-session', '-t', sessionName]);
            } catch (e) {
                // Ignore if already dead
            }
            delete sessions[userId];
        },

        startPolling: function () {
            if (this.pollingInterval) return;

            console.log(`[TMUX] Start polling for ${sessionName}`);
            this.pollingInterval = setInterval(async () => {
                try {
                    // Capture pane content
                    // -p: print to stdout
                    // -t: target
                    // -S -: start from very beginning of history? No, that's too much.
                    // Just capture visible screen or last N lines?
                    // Let's capture the visible pane first.
                    // Or maybe -S -100 to get last 100 lines.

                    const output = await runTmuxCommand(['capture-pane', '-p', '-t', sessionName, '-S', '-50']);

                    if (output === this.lastSnapshot) return; // No change

                    // Calculate diff: find what's new
                    // Simple logic: if new output starts with old output, take the remainder.
                    // But terminal scrolling makes this hard.
                    // Alternative: Just send the whole visible screen if it changed? No, spammy.

                    // Simple approach for now:
                    // Store the raw output. If changed, we define "new content" as 
                    // lines that are not in the last snapshot?
                    // Let's generic "update message" approach:
                    // We update the Slack message with the *entire* last 50 lines (or sanitized).
                    // This creates a "Live Terminal Window" effect in Slack.

                    this.lastSnapshot = output;
                    this.updateSlack(output, client, channelId);

                } catch (err) {
                    // Check if session died
                    if (err.message.includes('find session')) {
                        console.log("Session died, stopping polling");
                        clearInterval(this.pollingInterval);
                        delete sessions[userId];
                    }
                }
            }, 1000); // Poll every second
        },

        updateSlack: async function (rawOutput, client, channelId) {
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
                                text: `*Claude Desktop (via Tmux)*\nSession: \`${this.sessionName}\``
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
                    this.slackTs = res.ts;
                    this.msgStartTime = Date.now(); // Reset timer
                } else {
                    await client.chat.update({
                        ...blockPayload,
                        ts: this.slackTs
                    });
                }
            } catch (err) {
                console.error("Slack update failed:", err.message);
                if (err.data && err.data.error === 'message_not_found') {
                    this.slackTs = null;
                }
            }
        }
    };
}

module.exports = { getOrCreateSession };
