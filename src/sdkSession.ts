/**
 * SDK Session Manager
 *
 * Manages Claude Agent SDK sessions for each user.
 * Replaces the tmux-based session management.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config';

// Types for SDK messages
export interface ToolApprovalRequest {
    requestId: string;
    toolName: string;
    input: any;
    signal?: AbortSignal;
}

export interface UserQuestionRequest {
    requestId: string;
    question: string;
    options: Array<{ label: string; value: string }>;
    signal?: AbortSignal;
}

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

export type ToolApprovalResult = boolean | { denied: true; feedback?: string };

export interface SessionCallbacks {
    cwd?: string;
    permissionMode?: PermissionMode;
    onMessage: (msg: any) => Promise<void>;
    onToolApproval: (request: ToolApprovalRequest) => Promise<ToolApprovalResult>;
    onUserQuestion?: (request: UserQuestionRequest) => Promise<string>;
    onComplete: (sessionId: string | null) => void;
    onError: (err: Error) => void;
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

interface UserSession {
    sessionId: string | null;
    abortController: AbortController | null;
    queryInstance: AsyncIterable<any> & { interrupt?: () => void; close?: () => void } | null;
    lastActivity: number;
    isActive: boolean;
    permissionMode: PermissionMode;
    tokenUsage: TokenUsage;
}

// Permission modes per session key (channelId)
const permissionModes = new Map<string, PermissionMode>();

/**
 * Get permission mode for a session
 */
export function getUserPermissionMode(sessionKey: string): PermissionMode {
    return permissionModes.get(sessionKey) || 'default';
}

/**
 * Set permission mode for a session
 */
export function setUserPermissionMode(sessionKey: string, mode: PermissionMode): void {
    permissionModes.set(sessionKey, mode);
    console.log(`[SDK] Session ${sessionKey} permission mode -> ${mode}`);
}

// Sessions map (keyed by channelId)
const sessions = new Map<string, UserSession>();

/**
 * Get or create a session
 */
function getOrCreateSession(sessionKey: string): UserSession {
    let session = sessions.get(sessionKey);
    if (!session) {
        session = {
            sessionId: null,
            abortController: null,
            queryInstance: null,
            lastActivity: Date.now(),
            isActive: false,
            permissionMode: getUserPermissionMode(sessionKey),
            tokenUsage: {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0
            }
        };
        sessions.set(sessionKey, session);
    }
    return session;
}

/**
 * Send a message to Claude via SDK
 */
export async function sendMessage(
    sessionKey: string,
    message: string,
    callbacks: SessionCallbacks
): Promise<void> {
    const session = getOrCreateSession(sessionKey);

    // If there's an active session, abort it first
    if (session.isActive && session.abortController) {
        session.abortController.abort();
    }

    // Create new abort controller
    session.abortController = new AbortController();
    session.isActive = true;
    session.lastActivity = Date.now();

    // Get permission mode
    const permissionMode = callbacks.permissionMode || getUserPermissionMode(sessionKey);

    const sdkOptions: any = {
        cwd: callbacks.cwd || config.defaultProjectPath || process.cwd(),
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'],
        abortSignal: session.abortController.signal,
        permissionMode: permissionMode,
    };

    // Resume existing session if available
    if (session.sessionId) {
        sdkOptions.resume = session.sessionId;
    }

    // Tool approval callback
    sdkOptions.canUseTool = async (toolName: string, input: any, context?: { signal?: AbortSignal }) => {
        const requestId = crypto.randomUUID();

        // Special handling for AskUserQuestion - get user answers via Slack
        if (toolName === 'AskUserQuestion' && callbacks.onUserQuestion) {
            console.log(`[SDK] AskUserQuestion tool detected`);

            try {
                // Extract questions from input
                const questions = input.questions || [];
                const answers: Record<string, string> = {};

                // Ask each question via Slack
                for (const q of questions) {
                    const options = (q.options || []).map((opt: any) => ({
                        label: opt.label,
                        value: opt.label  // Use label as value for simplicity
                    }));

                    const answer = await callbacks.onUserQuestion({
                        requestId: crypto.randomUUID(),
                        question: q.question,
                        options
                    });

                    // Store answer using header as key
                    answers[q.header || q.question] = answer;
                }

                console.log(`[SDK] AskUserQuestion answers:`, answers);

                // Return allow with updated input including answers
                return {
                    behavior: 'allow' as const,
                    updatedInput: { ...input, answers }
                };
            } catch (err) {
                console.error(`[SDK] AskUserQuestion error:`, err);
                return { behavior: 'deny' as const, message: 'User question cancelled' };
            }
        }

        try {
            const result = await callbacks.onToolApproval({
                requestId,
                toolName,
                input,
                signal: context?.signal
            });

            // Handle boolean or feedback response
            if (result === true) {
                return { behavior: 'allow' as const };
            } else if (result === false) {
                return { behavior: 'deny' as const, message: 'User denied the tool use' };
            } else if (typeof result === 'object' && result.denied) {
                // Denied with feedback
                const feedbackMsg = result.feedback
                    ? `User denied with feedback: ${result.feedback}`
                    : 'User denied the tool use';
                return { behavior: 'deny' as const, message: feedbackMsg };
            }

            return { behavior: 'deny' as const, message: 'User denied the tool use' };
        } catch (err) {
            // If aborted or error, deny
            return { behavior: 'deny' as const, message: 'Tool approval cancelled' };
        }
    };

    try {
        const queryInstance = query({
            prompt: message,
            options: sdkOptions
        });

        // Store query instance for interrupt/close
        session.queryInstance = queryInstance;

        for await (const msg of queryInstance) {
            // Capture session ID from init message
            if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
                session.sessionId = msg.session_id;
                console.log(`[SDK] Session created: ${session.sessionId}`);
            }

            // Forward message to callback
            await callbacks.onMessage(msg);

            // Update activity timestamp
            session.lastActivity = Date.now();
        }

        session.isActive = false;
        session.queryInstance = null;
        callbacks.onComplete(session.sessionId);

    } catch (err: any) {
        session.isActive = false;
        session.queryInstance = null;

        if (err.name === 'AbortError') {
            console.log(`[SDK] Session aborted for ${sessionKey}`);
            callbacks.onComplete(session.sessionId);
        } else {
            console.error(`[SDK] Error for ${sessionKey}:`, err);
            callbacks.onError(err);
        }
    }
}

/**
 * Interrupt an active session (immediate stop, keeps session)
 * Uses SDK's interrupt() method for immediate termination
 */
export function interruptSession(sessionKey: string): boolean {
    const session = sessions.get(sessionKey);
    if (session && session.isActive) {
        // Try SDK interrupt first
        if (session.queryInstance && typeof session.queryInstance.interrupt === 'function') {
            session.queryInstance.interrupt();
            console.log(`[SDK] Interrupted session for ${sessionKey} via SDK interrupt()`);
        }
        // Also signal abort controller as fallback
        if (session.abortController) {
            session.abortController.abort();
        }
        session.isActive = false;
        session.queryInstance = null;
        return true;
    }
    return false;
}

/**
 * Close an active session (full termination, ends session)
 * Uses SDK's close() method to fully terminate the session
 */
export function closeSession(sessionKey: string): boolean {
    const session = sessions.get(sessionKey);
    if (session) {
        // Use SDK close if available
        if (session.queryInstance && typeof session.queryInstance.close === 'function') {
            session.queryInstance.close();
            console.log(`[SDK] Closed session for ${sessionKey} via SDK close()`);
        }
        // Also signal abort controller
        if (session.abortController && session.isActive) {
            session.abortController.abort();
        }
        session.isActive = false;
        session.queryInstance = null;
        session.sessionId = null;  // Clear session ID on close
        return true;
    }
    return false;
}

/**
 * Get session info
 */
export function getSessionInfo(sessionKey: string): { sessionId: string | null; isActive: boolean } | null {
    const session = sessions.get(sessionKey);
    if (!session) return null;

    return {
        sessionId: session.sessionId,
        isActive: session.isActive
    };
}

/**
 * Get token usage for a session
 */
export function getTokenUsage(sessionKey: string): TokenUsage | null {
    const session = sessions.get(sessionKey);
    if (!session) return null;
    return { ...session.tokenUsage };
}

/**
 * Update token usage for a session
 */
export function updateTokenUsage(sessionKey: string, usage: Partial<TokenUsage>): void {
    const session = sessions.get(sessionKey);
    if (session) {
        if (usage.inputTokens) session.tokenUsage.inputTokens += usage.inputTokens;
        if (usage.outputTokens) session.tokenUsage.outputTokens += usage.outputTokens;
        if (usage.cacheReadTokens) session.tokenUsage.cacheReadTokens += usage.cacheReadTokens;
        if (usage.cacheWriteTokens) session.tokenUsage.cacheWriteTokens += usage.cacheWriteTokens;
        console.log(`[SDK] Updated token usage for ${sessionKey}:`, session.tokenUsage);
    } else {
        console.log(`[SDK] No session found for ${sessionKey} to update token usage`);
    }
}

/**
 * Clear session (removes from memory completely)
 */
export function clearSession(sessionKey: string): void {
    const session = sessions.get(sessionKey);
    if (session) {
        // Close SDK session properly
        if (session.queryInstance && typeof session.queryInstance.close === 'function') {
            session.queryInstance.close();
        }
        if (session.abortController && session.isActive) {
            session.abortController.abort();
        }
        sessions.delete(sessionKey);
        console.log(`[SDK] Cleared session for ${sessionKey}`);
    }
}

/**
 * Clear all sessions
 */
export function clearAllSessions(): void {
    for (const [sessionKey, session] of sessions) {
        // Close SDK session properly
        if (session.queryInstance && typeof session.queryInstance.close === 'function') {
            session.queryInstance.close();
        }
        if (session.abortController && session.isActive) {
            session.abortController.abort();
        }
    }
    sessions.clear();
    console.log('[SDK] Cleared all sessions');
}
