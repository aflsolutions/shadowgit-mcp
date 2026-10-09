import * as z from 'zod/v4';
import { toLocalIso } from './time.js';

export class AppNotRunningError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      `ShadowGit isn't running: nothing answered on ${endpoint()}. Ask the user to open the ShadowGit app, then try again. Reading history with git_command still works.`,
      options,
    );
  }
}

/** No answer in time: the app may be busy rather than closed, and may still act on the request. */
export class AppTimeoutError extends Error {
  constructor(seconds: number, options?: ErrorOptions) {
    super(`ShadowGit did not answer within ${seconds} s. The app may be busy with a large project; try again in a moment.`, options);
  }
}

// Under the MCP SDK client's default request timeout of 60 s, so our message arrives before the client gives up.
const CHECKPOINT_TIMEOUT_MS = 55_000;

const APP_TOO_OLD = "This version of ShadowGit can't create checkpoints for AI assistants. Ask the user to update the ShadowGit app.";

const Session = z.object({
  id: z.string(),
  repoPath: z.string(),
  description: z.string().nullable().transform((description) => description ?? ''),
  // SQLite's CURRENT_TIMESTAMP: UTC written as "2026-10-08 10:00:00"; local ISO time here.
  startedAt: z.string().transform((utc) => toLocalIso(new Date(`${utc.replace(' ', 'T')}Z`))),
});
const Sessions = z.object({ sessions: z.array(Session) });
const StartedSession = z.object({ sessionId: z.string() });
const Checkpoint = z.object({ commit: z.string(), filesChanged: z.number() });
const ErrorReply = z.object({ error: z.string() });

export type ActiveSession = z.infer<typeof Session>;

const baseUrl = () => process.env.SHADOWGIT_SESSION_API ?? 'http://localhost:45289/api';

/** Host and port the requests go to (localhost:45289 by default). Never the raw value: it may hold credentials. */
function endpoint(): string {
  const url = baseUrl();
  return (URL.canParse(url) && new URL(url).host) || 'the address in SHADOWGIT_SESSION_API';
}

/** A POST when there is a body, else a GET. Any status but 200 and the ones in `accept` throws; the caller handles those. */
async function request(
  route: string,
  body?: object,
  { timeoutMs = 3_000, accept = [] }: { timeoutMs?: number; accept?: number[] } = {},
): Promise<{ status: number; json: unknown }> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${baseUrl()}${route}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The same signal covers the body: an app that sends headers and stalls must time out the same way.
    text = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new AppTimeoutError(timeoutMs / 1_000, { cause: error });
    throw new AppNotRunningError({ cause: error });
  }
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // An app without the route, or one that crashed, answers with HTML; the status says what happened.
  }
  if (response.status !== 200 && !accept.includes(response.status)) throw failure(response.status, json);
  return { status: response.status, json };
}

function failure(status: number, json: unknown): Error {
  const reply = ErrorReply.safeParse(json);
  return new Error(reply.success ? `ShadowGit: ${reply.data.error}` : `ShadowGit answered HTTP ${status}.`);
}

export async function activeSessions(): Promise<ActiveSession[]> {
  const { json } = await request('/session/active');
  return Sessions.parse(json).sessions;
}

export async function startSession(repoPath: string, description: string, aiTool: string): Promise<string> {
  const { json } = await request('/session/start', { repoPath, description, aiTool });
  return StartedSession.parse(json).sessionId;
}

export async function endSession(sessionId: string): Promise<void> {
  await request('/session/end', { sessionId });
}

export async function createCheckpoint(input: {
  repoPath: string;
  title: string;
  message?: string;
  author: string;
}): Promise<{ commit: string | null; filesChanged: number }> {
  // The app runs git add and git commit inside this request, which takes a while on a large project.
  const { status, json } = await request('/checkpoint', input, { timeoutMs: CHECKPOINT_TIMEOUT_MS, accept: [404, 409] }).catch((error: unknown) => {
    if (!(error instanceof AppTimeoutError)) throw error;
    throw new Error(
      `ShadowGit did not answer within ${CHECKPOINT_TIMEOUT_MS / 1_000} s; the checkpoint may still be saving. Check with git_command (log -1) before trying again.`,
      { cause: error },
    );
  });
  if (status === 404) throw new Error(APP_TOO_OLD);
  if (status === 409) return { commit: null, filesChanged: 0 };
  return Checkpoint.parse(json);
}
