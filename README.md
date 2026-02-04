# Slack-Claude Bridge

A bridge application that allows interaction with Claude CLI through Slack messages. It manages Claude CLI processes via tmux sessions and streams terminal output to Slack in real-time.

## Features

- Forward Slack messages to Claude CLI
- tmux-based session management (independent sessions per user)
- Real-time terminal output streaming
- Keyboard input mapping (Enter, arrows, Tab, etc.)
- Session recovery and orphan session detection

## Requirements

- Node.js 18+
- tmux
- Claude CLI (`claude` command must be in PATH)
- Slack App (Socket Mode enabled)

## Installation

```bash
# Clone repository
git clone <repository-url>
cd slack-claude-bridge

# Install dependencies
npm install

# Configure environment variables
cp .env.example .env
# Edit .env file to add Slack credentials
```

## Slack App Setup (Automatic Configuration)

The easiest way is to use **App Manifest**.

1. Go to [Slack API Apps](https://api.slack.com/apps) page.
2. Select **Create New App** -> **From an app manifest**.
3. Select your workspace and paste the following **YAML** code.

```yaml
display_information:
  name: Claude Bridge
  description: Connect local Claude CLI to Slack via Tmux
  background_color: "#2c2d30"
features:
  bot_user:
    display_name: Claude Bridge
    always_online: true
  slash_commands:
    - command: /cd
      description: Change working directory
      usage_hint: /path/to/project
    - command: /reset
      description: Clear output buffer
    - command: /exit
      description: Terminate current session
oauth_config:
  scopes:
    bot:
      - chat:write
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - commands
      - files:write
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
```

4. After creating the app, click **Install to Workspace** to install it.

## Finding Tokens and Keys

After creating the app, fill in the following information in the `.env` file.

| Variable | Location (Left Sidebar Menu) | Description |
|----------|------------------------------|-------------|
| **`SLACK_SIGNING_SECRET`** | **Basic Information** > **App Credentials** | The app's signing secret. |
| **`SLACK_APP_TOKEN`** | **Basic Information** > **App-Level Tokens** | Click **Generate Token and Scopes** -> Enter name -> Add `connections:write` scope and generate. (Starts with `xapp-`) |
| **`SLACK_BOT_TOKEN`** | **OAuth & Permissions** > **OAuth Tokens for Your Workspace** | Generated after app installation. (Starts with `xoxb-`) |
| **`ALLOWED_USER_ID`** | In Slack, click your profile > **More(...)** > **Copy member ID** | Set to allow only yourself for security. (Optional) |

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (xoxb-...) | Yes |
| `SLACK_APP_TOKEN` | App-Level Token (xapp-...) | Yes |
| `SLACK_SIGNING_SECRET` | Signing Secret | Yes |
| `ALLOWED_USER_ID` | Allowed user ID (allows all if empty) | No |
| `CLAUDE_PATH` | Claude CLI path (default: `claude`) | No |

## Running

### Production
First, build the TypeScript code.

```bash
npm run build
npm start
```

### Development Mode
Use this when you want to see changes immediately while modifying code.

```bash
npm run dev
```

## Usage

### Basic Commands

| Command | Description | Notes |
|---------|-------------|-------|
| `/cd <path>` | Start new session in the specified path | Can also use as regular message like `cd <path>` |
| `/exit` | Terminate current session (Claude) | Can also type `exit` |
| `/reset` | Clear output buffer | Can also type `clear` |
| `/full` | Upload full terminal output as file | |
| Regular message | Forwarded directly to Claude | |

> **Tip:** Paths can use `~` (home directory) like `~/workspace`.

### Key Inputs

| Input | Action |
|-------|--------|
| `.` or `enter` | Enter key |
| `up` or `k` | Up arrow |
| `down` or `j` | Down arrow |
| `esc` | Escape key |
| `ctrl-c` | Ctrl+C |
| `tab` | Tab key |
| `stab` or `shift-tab` | Shift+Tab |

## License

MIT
