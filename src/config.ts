// Configuration with environment variable overrides

export const config = {
  // Polling interval for tmux output capture (ms)
  pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || '1000'),

  // Message rotation timeout - create new Slack message after this duration (ms)
  messageRotationMs: parseInt(process.env.MESSAGE_ROTATION_MS || '60000'),

  // Maximum message length before truncation
  maxMessageLength: parseInt(process.env.MAX_MESSAGE_LENGTH || '2500'),

  // File upload threshold - upload as file if output exceeds this length
  fileUploadThreshold: parseInt(process.env.FILE_UPLOAD_THRESHOLD || '3000'),

  // Tmux window dimensions
  tmuxWidth: parseInt(process.env.TMUX_WIDTH || '200'),
  tmuxHeight: parseInt(process.env.TMUX_HEIGHT || '50'),

  // Number of lines to capture from tmux buffer
  tmuxBufferLines: parseInt(process.env.TMUX_BUFFER_LINES || '50'),

  // Path to Claude CLI
  claudePath: process.env.CLAUDE_PATH || '/usr/local/bin/claude',
};
