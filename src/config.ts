// Configuration with environment variable overrides

export const config = {
    // Default project path for Claude
    defaultProjectPath: process.env.DEFAULT_PROJECT_PATH || process.cwd(),

    // Tool approval timeout (ms) - must be under SDK's 60s limit
    toolApprovalTimeoutMs: parseInt(process.env.TOOL_APPROVAL_TIMEOUT_MS || '55000'),

    // Allowed tools for Claude
    allowedTools: (process.env.ALLOWED_TOOLS || 'Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch').split(','),

    // Auto-approve safe tools (no confirmation needed)
    autoApproveTools: (process.env.AUTO_APPROVE_TOOLS || 'Read,Glob,Grep').split(','),

    // Path to Claude CLI
    claudePath: process.env.CLAUDE_PATH || 'claude',
};
