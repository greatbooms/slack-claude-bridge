import * as dotenv from 'dotenv';
dotenv.config();
import { App } from '@slack/bolt';
import * as fs from 'fs';
import * as path from 'path';
import { getOrCreateSession } from './sessionManager';

interface MinimalMessageEvent {
    user: string;
    text?: string;
    channel: string;
    ts: string;
}

// Initialize App
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    signingSecret: process.env.SLACK_SIGNING_SECRET
});

const ALLOWED_USER = process.env.ALLOWED_USER_ID;

app.message(async ({ message, say, client }) => {
    // Cast to access 'user' and 'text' safely
    const msg = message as unknown as MinimalMessageEvent;

    // Ignore events without user (e.g. system messages, message_changed)
    if (!msg.user) return;

    // 1. Check User ID for security
    if (ALLOWED_USER && msg.user !== ALLOWED_USER) {
        console.log(`Unauthorized access attempt from ${msg.user}`);
        return;
    }

    let text = msg.text ? msg.text.trim() : "";
    if (!text) return;

    // Remove Slack code block formatting (``` ... ```)
    if (text.startsWith('```') && text.endsWith('```')) {
        text = text.slice(3, -3).trim();
    } else if (text.startsWith('```')) {
        text = text.slice(3).trim();
    } else if (text.endsWith('```')) {
        text = text.slice(0, -3).trim();
    }
    // Also handle single backticks for inline code
    if (text.startsWith('`') && text.endsWith('`') && !text.includes('\n')) {
        text = text.slice(1, -1).trim();
    }

    if (!text) return;

    // 2. Handle /cd or /open command (Switch Project)
    // Note: Slash commands usually come via app.command(), but we handle text-based "commands" here too
    if (text.startsWith("/cd ") || text.startsWith("/open ") || text.startsWith("cd ") || text.startsWith("open ")) {
        // Remove command part
        const parts = text.split(" ");
        let targetPath = parts.slice(1).join(" ").trim();

        // Handle case where user types just "cd" (go home)
        if (parts.length === 1 && (parts[0] === 'cd' || parts[0] === '/cd')) {
            targetPath = process.env.HOME || '/';
        }

        if (targetPath) {
            // Expand ~ to HOME
            if (targetPath.startsWith('~/') && process.env.HOME) {
                targetPath = path.join(process.env.HOME, targetPath.slice(2));
            } else if (targetPath === '~' && process.env.HOME) {
                targetPath = process.env.HOME;
            }

            // Verify path exists
            if (!fs.existsSync(targetPath)) {
                await say(`❌ Directory not found: \`${targetPath}\`\nPlease check the path and try again.`);
                return;
            }

            // Force create new session (restart)
            try {
                await getOrCreateSession(msg.user, client, msg.channel, targetPath, true);
                await say(`🔄 Restarting Claude in: \`${targetPath}\``);
            } catch (e: any) {
                await say(`❌ Failed to start session: ${e.message}`);
            }
            return;
        }
    }

    // 3. Handle specific control commands
    if (text === '/exit' || text === 'exit' || text === '종료') {
        const session = await getOrCreateSession(msg.user, client, msg.channel, undefined);
        if (session) {
            await session.terminate();
            await say("🛑 Session terminated.");
        }
        return;
    }

    if (text === '/reset' || text === 'clear' || text === 'reset') {
        const session = await getOrCreateSession(msg.user, client, msg.channel, undefined);
        if (session) {
            // For now, let's send 'clear' command to tmux
            await session.write('clear');
            // And also tell slack to start new block
            session.slackTs = null;
            await say("🧹 Output cleared. Starting new block.");
        }
        return;
    }

    // Handle /full command - upload full terminal output as file
    if (text === '/full' || text === 'full') {
        const session = await getOrCreateSession(msg.user, client, msg.channel, undefined);
        if (session) {
            await session.uploadFullOutput(client, msg.channel);
        }
        return;
    }

    // 4. Default: Forward message to Claude process
    try {
        const session = await getOrCreateSession(msg.user, client, msg.channel, undefined);
        await session.write(text);
    } catch (e: any) {
        await say(`❌ Error: ${e.message}`);
    }
});

(async () => {
    await app.start();
    console.log('⚡️ Slack-Claude Bridge (Terminal Mode) is running!');
})();
