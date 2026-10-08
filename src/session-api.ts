import * as z from 'zod/v4';
import { toLocalIso } from './time.js';

export class AppNotRunningError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "ShadowGit isn't running: nothing answered on localhost:45289. Ask the user to open the ShadowGit app, then try again. Reading history with git_command still works.",
      options,
    );
  }
}

/** No answer in time: the app may be busy rather than closed, and may still act on the request. */
export class AppTimeoutError extends Error {
  constructor(seconds: number, options?: ErrorOptions) {
    super(`ShadowGit did not answer within ${seconds} s.`, options);
  }
}

// Under the MCP SDK client's default request timeout of 60 s, so our message arrives before the client gives up.
const CHECKPOINT_TIMEOUT_MS = 55_000;

const APP_TOO_OLD = "This version of ShadowGit can't create checkpoints for AI assistants. Ask the user to update the ShadowGit app.";

export interface ActiveSession {
  id: string;
  repoPath: string;
  description: string;
  /** Local ISO time. */
  startedAt: string;
}

const Sessions = z.object({
  sessions: z.array(z.object({ id: z.string(), repoPath: z.string(), description: z.string().nullable(), startedAt: z.string() })),
});

const baseUrl = () => process.env.SHADOWGIT_SESSION_API ?? 'http://localhost:45289/api';

async function request(
  method: 'GET' | 'POST',
  route: string,
  body?: object,
  timeoutMs = 3_000,
): Promise<{ status: number; json: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${route}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new AppTimeoutError(timeoutMs / 1_000, { cause: error });
    throw new AppNotRunningError({ cause: error });
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // An app without the route, or one that crashed, answers with HTML; the status says what happened.
  }
  return { status: response.status, json };
}

function failure(status: number, json: unknown): Error {
  const reply = z.object({ error: z.string() }).safeParse(json);
  return new Error(reply.success ? `ShadowGit: ${reply.data.error}` : `ShadowGit answered HTTP ${status}.`);
}

export async function activeSessions(): Promise<ActiveSession[]> {
  const { status, json } = await request('GET', '/session/active');
  if (status !== 200) throw failure(status, json);
  return Sessions.parse(json).sessions.map((s) => ({
    id: s.id,
    repoPath: s.repoPath,
    description: s.description ?? '',
    // SQLite's CURRENT_TIMESTAMP: UTC written as "2026-10-08 10:00:00".
    startedAt: toLocalIso(new Date(`${s.startedAt.replace(' ', 'T')}Z`)),
  }));
}

export async function startSession(repoPath: string, description: string, aiTool: string): Promise<string> {
  const { status, json } = await request('POST', '/session/start', { repoPath, description, aiTool });
  if (status !== 200) throw failure(status, json);
  return z.object({ sessionId: z.string() }).parse(json).sessionId;
}

export async function endSession(sessionId: string): Promise<void> {
  const { status, json } = await request('POST', '/session/end', { sessionId });
  if (status !== 200) throw failure(status, json);
}

export async function createCheckpoint(input: {
  repoPath: string;
  title: string;
  message?: string;
  author: string;
}): Promise<{ commit: string | null; filesChanged: number }> {
  // The app runs git add and git commit inside this request, which takes a while on a large project.
  const { status, json } = await request('POST', '/checkpoint', input, CHECKPOINT_TIMEOUT_MS).catch((error: unknown) => {
    if (!(error instanceof AppTimeoutError)) throw error;
    throw new Error(
      `ShadowGit did not answer within ${CHECKPOINT_TIMEOUT_MS / 1_000} s; the checkpoint may still be saving. Check with git_command (log -1) before trying again.`,
      { cause: error },
    );
  });
  if (status === 404) throw new Error(APP_TOO_OLD);
  if (status === 409) return { commit: null, filesChanged: 0 };
  if (status !== 200) throw failure(status, json);
  return z.object({ commit: z.string(), filesChanged: z.number() }).parse(json);
}
