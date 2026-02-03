require('dotenv').config();
const { App } = require('@slack/bolt');
const fs = require('fs');
const path = require('path');
const { getOrCreateSession } = require('./sessionManager');
// Initialize App
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    signingSecret: process.env.SLACK_SIGNING_SECRET
});

const ALLOWED_USER = process.env.ALLOWED_USER_ID;

app.message(async ({ message, say, client }) => {
    // Ignore events without user (e.g. system messages, message_changed)
    if (!message.user) return;

    // 1. Check User ID for security
    if (ALLOWED_USER && message.user !== ALLOWED_USER) {
        console.log(`Unauthorized access attempt from ${message.user}`);
        return;
    }

    const text = message.text ? message.text.trim() : "";
    if (!text) return;

    // 2. Handle /cd or /open command (Switch Project)
    if (text.startsWith("/cd ") || text.startsWith("/open ") || text.startsWith("cd ") || text.startsWith("open ")) {
        // Remove command part
        const parts = text.split(" ");
        let targetPath = parts.slice(1).join(" ").trim();

        // Handle case where user types just "cd" (go home)
        if (parts.length === 1 && (parts[0] === 'cd' || parts[0] === '/cd')) {
            targetPath = process.env.HOME;
        }

        if (targetPath) {
            // Expand ~ to HOME
            if (targetPath.startsWith('~/')) {
                targetPath = path.join(process.env.HOME, targetPath.slice(2));
            } else if (targetPath === '~') {
                targetPath = process.env.HOME;
            }

            // Verify path exists
            if (!fs.existsSync(targetPath)) {
                await say(`❌ Directory not found: \`${targetPath}\`\nPlease check the path and try again.`);
                return;
            }

            // Force create new session (restart)
            try {
                await getOrCreateSession(message.user, client, message.channel, targetPath, true);
                await say(`🔄 Restarting Claude in: \`${targetPath}\``);
            } catch (e) {
                await say(`❌ Failed to start session: ${e.message}`);
            }
            return;
        }
    }

    // 3. Handle specific control commands
    if (text === '/exit' || text === 'exit' || text === '종료') {
        const session = await getOrCreateSession(message.user, client, message.channel);
        if (session) {
            session.terminate();
            await say("🛑 Session terminated.");
        }
        return;
    }

    if (text === '/reset' || text === 'clear' || text === 'reset') {
        const session = await getOrCreateSession(message.user, client, message.channel);
        if (session) {
            session.outputBuffer = [];
            session.slackTs = null;
            await say("🧹 Output cleared. Starting new block.");
        }
        return;
    }

    // 4. Default: Forward message to Claude process
    try {
        const session = await getOrCreateSession(message.user, client, message.channel);
        session.write(text);
    } catch (e) {
        await say(`❌ Error: ${e.message}`);
    }
});

(async () => {
    await app.start();
    console.log('⚡️ Slack-Claude Bridge (Terminal Mode) is running!');
})();
