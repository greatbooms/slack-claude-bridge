# Slack-Claude Bridge

A bridge application that connects Slack to Claude using the Claude Agent SDK. Supports interactive tool approval via Slack buttons and channel-based session management.

## Features

- Forward Slack messages to Claude Agent SDK
- **Image support** - Send images with messages for Claude to analyze
- Channel-based session management (independent sessions per channel)
- Interactive tool approval via Slack buttons (Allow / Deny / Always Allow)
- Interactive question handling via Slack buttons (AskUserQuestion)
- Plan mode with "Deny with Feedback" option
- Permission modes (default, acceptEdits, bypassPermissions)
- Real-time streaming responses
- Per-channel working directory
- Token usage tracking per session

## Requirements

- Node.js 18+
- Claude CLI installed (`claude` command must be in PATH)
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

## Slack App Setup

### Using App Manifest (Recommended)

1. Go to [Slack API Apps](https://api.slack.com/apps) page.
2. Select **Create New App** -> **From an app manifest**.
3. Select your workspace and paste the following **YAML** code.

```yaml
display_information:
  name: Claude Bridge
  description: Connect Claude Agent SDK to Slack
  background_color: "#2c2d30"
features:
  bot_user:
    display_name: Claude Bridge
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - files:read
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

### Required Bot Events

| Event | Description |
|-------|-------------|
| `message.channels` | Receive messages in public channels |
| `message.groups` | Receive messages in private channels |
| `message.im` | Receive direct messages |
| `message.mpim` | Receive messages in group DMs |

> **Important:** `interactivity` must be enabled for tool approval buttons to work.

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
| `DEFAULT_PROJECT_PATH` | Default working directory | No |

## Running

### Production

```bash
npm run build
npm start
```

### Development Mode

```bash
npm run dev
```

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `help` | Show available commands |
| `cd [path]` | Show or change working directory |
| `status` | Show session status (session ID, working dir, mode) |
| `usage` | Show token usage for current session |
| `mode [mode]` | Show or change permission mode |
| `abort` | Interrupt current operation (immediate stop) |
| `exit` | Terminate current session (full close) |
| `clear` | Clear message tracking |

> **Tip:** Paths support `~` expansion (e.g., `cd ~/workspace/my-project`)

### Permission Modes

| Mode | Command | Description |
|------|---------|-------------|
| Default | `mode default` | Ask for approval on each tool use |
| Accept Edits | `mode accept` | Auto-approve file edits (Read, Write, Edit) |
| Bypass | `mode bypass` | Auto-approve all tools (use with caution!) |

### Tool Approval

When Claude wants to use a tool (e.g., Bash, Write), you'll see approval buttons:

- **Allow** - Approve this tool use
- **Deny** - Reject this tool use
- **Always Allow** - Auto-approve this tool for the rest of the session

For plan mode (ExitPlanMode), you'll see:

- **Allow** - Approve the plan
- **Deny** - Reject the plan
- **Deny with Feedback** - Reject with comments for Claude to revise

### Image Support

You can send images with your messages for Claude to analyze:

- Attach an image to your Slack message
- Optionally add text describing what you want to know
- Claude will use the Read tool to view and analyze the image

Supported formats: JPEG, PNG, GIF, WebP

Example:
```
[Attach screenshot] What's the error in this screenshot?
```

### Multi-Channel Usage

Each Slack channel has an independent session:

1. Create channels for different projects (e.g., `#claude-frontend`, `#claude-backend`)
2. Invite the bot to each channel (`/invite @Claude Bridge`)
3. Set working directory in each channel:
   ```
   cd ~/workspace/frontend    (in #claude-frontend)
   cd ~/workspace/backend     (in #claude-backend)
   ```
4. Conversations in each channel are completely isolated

## Architecture

```
Slack <-> Slack-Claude Bridge <-> Claude Agent SDK <-> Claude API
              |
              +-- Channel A Session (cwd: /project-a)
              +-- Channel B Session (cwd: /project-b)
              +-- Channel C Session (cwd: /project-c)
```

## License

MIT
