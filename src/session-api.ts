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

// For a request that may run long (a checkpoint, a lens drawn in the request): under the MCP SDK client's default
// request timeout of 60 s, so our message arrives before the client gives up.
const SLOW_REQUEST_TIMEOUT_MS = 55_000;

const APP_TOO_OLD = "This version of ShadowGit can't create checkpoints for AI assistants. Ask the user to update the ShadowGit app.";
const APP_WITHOUT_LENS = 'This version of ShadowGit has no Lens for AI assistants. Ask the user to update the ShadowGit app.';

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

const LensRange = z.object({ base: z.string().nullable(), head: z.string() });
const LensSkeleton = z.object({
  title: z.string(),
  words: z.object({ source: z.string(), author: z.string().nullable() }),
  summary: z.string().nullable(),
  steps: z.array(z.object({ id: z.string(), title: z.string(), body: z.string().nullable(), components: z.array(z.string()), files: z.array(z.string()), diff: z.string() })),
  components: z.array(z.object({
    id: z.string(), name: z.string(), kind: z.string(), delta: z.string(), context: z.boolean(), role: z.string().nullable(), path: z.string(), symbols: z.array(z.string()),
  })),
  layers: z.array(z.object({ id: z.string(), name: z.string() })),
  flows: z.array(z.object({ id: z.string(), from: z.string(), to: z.string(), label: z.string() })),
});
export const LensRead = z.object({ range: LensRange, lens: LensSkeleton.nullable(), limits: z.record(z.string(), z.number()) });
const LensApplied = z.object({ summary: z.boolean(), steps: z.number(), components: z.number(), layers: z.number(), flows: z.number() });
export const WordsWritten = z.object({ applied: LensApplied, ignored: z.array(z.string()) });

/** The words an agent writes over a lens, by the ids get_lens gave: the app's author contract. */
export interface LensWords {
  summary?: string;
  steps?: { id: string; title?: string; body?: string }[];
  components?: { id: string; role: string }[];
  layers?: { id: string; name: string }[];
  flows?: { id: string; label: string }[];
}

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
  const { status, json } = await request('/checkpoint', input, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS, accept: [404, 409] }).catch((error: unknown) => {
    if (!(error instanceof AppTimeoutError)) throw error;
    throw new Error(
      `ShadowGit did not answer within ${SLOW_REQUEST_TIMEOUT_MS / 1_000} s; the checkpoint may still be saving. Check with git_command (log -1) before trying again.`,
      { cause: error },
    );
  });
  if (status === 404) throw new Error(APP_TOO_OLD);
  if (status === 409) return { commit: null, filesChanged: 0 };
  return Checkpoint.parse(json);
}

/** The lens of a range for the agent to word: the latest AI session's without a head. The app may draw it inside the request. */
export async function readLens(input: { repoPath: string; base?: string | null; head?: string }): Promise<z.infer<typeof LensRead>> {
  // An empty base is the empty tree: a range from the start of the history
  const query = new URLSearchParams({ repoPath: input.repoPath });
  if (input.head !== undefined) {
    query.set('base', input.base ?? '');
    query.set('head', input.head);
  }
  const { status, json } = await request(`/lens?${query}`, undefined, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS, accept: [404] });
  if (status === 404) throw new Error(APP_WITHOUT_LENS);
  return LensRead.parse(json);
}

/** The agent's words for a range; the app keeps them in its history, next to the range's newest snapshot. */
export async function sendLensWords(input: { repoPath: string; base: string | null; head: string; author: string; words: LensWords }): Promise<z.infer<typeof WordsWritten>> {
  const { status, json } = await request('/lens/words', input, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS, accept: [404] });
  if (status === 404) throw new Error(APP_WITHOUT_LENS);
  return WordsWritten.parse(json);
}
