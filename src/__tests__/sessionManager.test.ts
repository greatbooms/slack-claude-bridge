import { stripAnsi, cleanTerminalOutput } from '../sessionManager';

describe('stripAnsi', () => {
  it('removes ANSI escape codes', () => {
    const input = '\x1b[31mred\x1b[0m';
    expect(stripAnsi(input)).toBe('red');
  });

  it('handles multiple ANSI codes', () => {
    const input = '\x1b[1m\x1b[32mbold green\x1b[0m normal';
    expect(stripAnsi(input)).toBe('bold green normal');
  });

  it('returns empty string for empty input', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('handles string with no ANSI codes', () => {
    const input = 'plain text';
    expect(stripAnsi(input)).toBe('plain text');
  });

  it('handles non-string input gracefully', () => {
    // @ts-expect-error - testing runtime behavior with wrong type
    expect(stripAnsi(null)).toBe(null);
    // @ts-expect-error - testing runtime behavior with wrong type
    expect(stripAnsi(undefined)).toBe(undefined);
  });

  it('removes cursor movement codes', () => {
    const input = '\x1b[2J\x1b[Htext';
    expect(stripAnsi(input)).toBe('text');
  });
});

describe('cleanTerminalOutput', () => {
  it('removes Claude logo characters', () => {
    const input = '▐▛ some logo\nactual content';
    expect(cleanTerminalOutput(input)).toBe('actual content');
  });

  it('removes lines with ▝▜ characters', () => {
    const input = '▝▜ banner\nreal output';
    expect(cleanTerminalOutput(input)).toBe('real output');
  });

  it('removes lines with ▘▘ characters', () => {
    const input = '▘▘ part\nactual content';
    expect(cleanTerminalOutput(input)).toBe('actual content');
  });

  it('removes Claude Code version line', () => {
    const input = 'Claude Code v1.0.0\nactual content';
    expect(cleanTerminalOutput(input)).toBe('actual content');
  });

  it('removes model info line with dot separator', () => {
    const input = 'Opus 4.5 · Ready\nactual content';
    expect(cleanTerminalOutput(input)).toBe('actual content');
  });

  it('shortens long separators', () => {
    const input = '─'.repeat(50);
    expect(cleanTerminalOutput(input)).toBe('────────────────────────');
  });

  it('keeps short separators unchanged', () => {
    const input = '─'.repeat(5);
    expect(cleanTerminalOutput(input)).toBe('─────');
  });

  it('removes status bar with pipe separator', () => {
    const input = 'Opus 4.5 | API\nactual content';
    expect(cleanTerminalOutput(input)).toBe('actual content');
  });

  it('removes pause indicator lines', () => {
    const input = '⏸ Paused\nactual content';
    expect(cleanTerminalOutput(input)).toBe('actual content');
  });

  it('removes play indicator lines', () => {
    const input = '▶ Running\nactual content';
    expect(cleanTerminalOutput(input)).toBe('actual content');
  });

  it('removes IDE hint lines', () => {
    const input = 'Use /ide for editor\nactual content';
    expect(cleanTerminalOutput(input)).toBe('actual content');
  });

  it('preserves normal content', () => {
    const input = 'Hello\nWorld\nTest';
    expect(cleanTerminalOutput(input)).toBe('Hello\nWorld\nTest');
  });

  it('trims whitespace from result', () => {
    const input = '\n\nactual content\n\n';
    expect(cleanTerminalOutput(input)).toBe('actual content');
  });

  it('handles empty input', () => {
    expect(cleanTerminalOutput('')).toBe('');
  });

  it('handles input with only filtered content', () => {
    const input = '▐▛ logo\nClaude Code v1.0.0\nOpus 4.5 · Ready';
    expect(cleanTerminalOutput(input)).toBe('');
  });
});
