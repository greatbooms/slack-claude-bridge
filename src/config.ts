// Configuration with environment variable overrides

export const config = {
    // Default project path for Claude
    defaultProjectPath: process.env.DEFAULT_PROJECT_PATH || process.cwd(),

    // Message rotation timeout - create new Slack message after this duration (ms)
    messageRotationMs: parseInt(process.env.MESSAGE_ROTATION_MS || '60000'),

    // Maximum message length before truncation
    maxMessageLength: parseInt(process.env.MAX_MESSAGE_LENGTH || '2500'),

    // File upload threshold - upload as file if output exceeds this length
    fileUploadThreshold: parseInt(process.env.FILE_UPLOAD_THRESHOLD || '3000'),

    // Tool approval timeout (ms) - must be under SDK's 60s limit
    toolApprovalTimeoutMs: parseInt(process.env.TOOL_APPROVAL_TIMEOUT_MS || '55000'),

    // Allowed tools for Claude
    allowedTools: (process.env.ALLOWED_TOOLS || 'Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch').split(','),

    // Auto-approve safe tools (no confirmation needed)
    autoApproveTools: (process.env.AUTO_APPROVE_TOOLS || 'Read,Glob,Grep').split(','),

    // ===== Legacy tmux config (kept for backwards compatibility) =====
    // Polling interval for tmux output capture (ms)
    pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || '1000'),

    // Tmux window dimensions
    tmuxWidth: parseInt(process.env.TMUX_WIDTH || '200'),
    tmuxHeight: parseInt(process.env.TMUX_HEIGHT || '50'),

    // Number of lines to capture from tmux buffer
    tmuxBufferLines: parseInt(process.env.TMUX_BUFFER_LINES || '50'),

    // Path to Claude CLI
    claudePath: process.env.CLAUDE_PATH || 'claude',
};
