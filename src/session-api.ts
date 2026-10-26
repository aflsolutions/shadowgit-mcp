import * as z from 'zod/v4';
import { AreaRead, ContextRead, SummaryRead } from './map-shapes.js';
import { CheckpointRules, Range, RuleCheck } from './rule-shapes.js';
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

// For a request that may run long (a checkpoint, a lens drawn or a map built in the request): under the MCP SDK
// client's default request timeout of 60 s, so our message arrives before the client gives up, and past the app's own
// 55 s for a map, so its "ask again in a minute" arrives first.
const SLOW_REQUEST_TIMEOUT_MS = 58_000;

const APP_TOO_OLD = "This version of ShadowGit can't create checkpoints for AI assistants. Ask the user to update the ShadowGit app.";
const APP_WITHOUT_LENS = 'This version of ShadowGit has no Lens for AI assistants. Ask the user to update the ShadowGit app.';
const APP_WITHOUT_MAP = 'This version of ShadowGit has no map for AI assistants. Ask the user to update the ShadowGit app.';
const CHECK_UNREAD = "ShadowGit checked this checkpoint against the project's rules and answered in a shape this version of shadowgit-mcp-server does not read. Ask the user to update shadowgit-mcp-server.";
const APP_WITHOUT_PIECES = "This version of ShadowGit reads a step's body as plain text only: ask the user to update the ShadowGit app, or send each body as plain text.";

const Session = z.object({
  id: z.string(),
  repoPath: z.string(),
  description: z.string().nullable().transform((description) => description ?? ''),
  // SQLite's CURRENT_TIMESTAMP: UTC written as "2026-10-08 10:00:00"; local ISO time here.
  startedAt: z.string().transform((utc) => toLocalIso(new Date(`${utc.replace(' ', 'T')}Z`))),
});
const Sessions = z.object({ sessions: z.array(Session) });
const StartedSession = z.object({ sessionId: z.string() });
// The check is read on its own: the checkpoint is saved whatever shape it comes in
const Checkpoint = z.object({ commit: z.string(), filesChanged: z.number(), rules: z.unknown().optional() });
const ErrorReply = z.object({ error: z.string() });

export const LensLines = z.object({ start: z.number().int(), end: z.number().int() });
/** A symbol of a step, with its lines on each side it has; `basePath` is its file in the base, null when the change added it. */
const LensSymbol = z.object({ name: z.string(), path: z.string(), basePath: z.string().nullable(), base: LensLines.nullable(), head: LensLines.nullable() });
/** An end of a dependency: an area by its label and folder, as get_map names it, or a layer (no path). */
const LensEnd = z.object({ label: z.string(), path: z.string().nullable() });
/** What the range makes depend on what, as the app words it. Open values are strings: a newer app may add to them. */
const LensDependency = z.object({
  sentence: z.string(),
  level: z.string().describe('area or layer'),
  kind: z.string().describe('new, gone, both (each now depends on the other) or count (a dependency that grew or shrank)'),
  from: LensEnd,
  to: LensEnd,
  evidence: z.array(z.string()).describe('The links the range added or removed that make it, at most 3'),
  steps: z.array(z.string()).describe('The ids of the steps that hold it'),
});
// An app older than linked words sends no quotes and no symbols; one older than the dependency facts sends none
const LensSkeleton = z.object({
  title: z.string(),
  words: z.object({ source: z.string(), author: z.string().nullable() }),
  summary: z.string().nullable(),
  quotes: z.array(z.string()).optional(),
  dependencies: z.object({ facts: z.array(LensDependency), more: z.number().int().describe('How many more facts past these') }).optional(),
  steps: z.array(z.object({
    id: z.string(), title: z.string(), body: z.string().nullable(), components: z.array(z.string()), files: z.array(z.string()), diff: z.string(), symbols: z.array(LensSymbol).optional(),
    dependencies: z.array(z.string()).optional().describe("The sentences of the step's own facts"),
    rules: z.array(z.string()).optional().describe('The texts of the rules that name links it holds'),
  })),
  components: z.array(z.object({
    id: z.string(), name: z.string(), kind: z.string(), delta: z.string(), context: z.boolean(), role: z.string().nullable(), path: z.string(), symbols: z.array(z.string()),
  })),
  layers: z.array(z.object({ id: z.string(), name: z.string() })),
  flows: z.array(z.object({ id: z.string(), from: z.string(), to: z.string(), label: z.string() })),
});
// An app older than the rules sends neither; rulesFailure only when the rules file can't be read
export const LensRead = z.object({
  range: Range,
  lens: LensSkeleton.nullable(),
  rules: RuleCheck.nullable().optional().describe("The range checked against the project's rules, also for a range with no lens; null without rules"),
  rulesFailure: z.string().optional().describe("Why the project's rules couldn't be read"),
  limits: z.record(z.string(), z.number()),
});
const LensApplied = z.object({ summary: z.boolean(), steps: z.number(), components: z.number(), layers: z.number(), flows: z.number() });
export const WordsWritten = z.object({ applied: LensApplied, ignored: z.array(z.string()) });

/**
 * The words an agent writes over a lens, by the ids get_lens gave: the app's author contract. A body's pieces link the
 * cards their text names; a why quotes a checkpoint message, the only text ShadowGit holds in its author's own words.
 */
export interface LensWords {
  summary?: string;
  steps?: {
    id: string;
    title?: string;
    body?: string | { text: string; card?: string }[];
    why?: { quote: string; source: 'commit' };
    excerpt?: { path: string; name: string; side: 'base' | 'head'; lines: z.infer<typeof LensLines> };
  }[];
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

/** An answer in the shape this version reads: one of another shape asks for a server update, not a parse error. */
function read<S extends z.ZodType>(shape: S, json: unknown, what: 'map' | 'lens' | 'session' | 'checkpoint'): z.infer<S> {
  const parsed = shape.safeParse(json);
  if (!parsed.success) throw new Error(`ShadowGit answered with a ${what} this version of shadowgit-mcp-server does not read. Ask the user to update shadowgit-mcp-server.`, { cause: parsed.error });
  return parsed.data;
}

function failure(status: number, json: unknown): Error {
  const reply = ErrorReply.safeParse(json);
  return new Error(reply.success ? `ShadowGit: ${reply.data.error}` : `ShadowGit answered HTTP ${status}.`);
}

export async function activeSessions(): Promise<ActiveSession[]> {
  const { json } = await request('/session/active');
  return read(Sessions, json, 'session').sessions;
}

export async function startSession(repoPath: string, description: string, aiTool: string): Promise<string> {
  const { json } = await request('/session/start', { repoPath, description, aiTool });
  return read(StartedSession, json, 'session').sessionId;
}

export async function endSession(sessionId: string): Promise<void> {
  await request('/session/end', { sessionId });
}

export async function createCheckpoint(input: {
  repoPath: string;
  title: string;
  message?: string;
  author: string;
}): Promise<{ commit: string | null; filesChanged: number; rules?: z.infer<typeof CheckpointRules> }> {
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
  const { commit, filesChanged, rules } = read(Checkpoint, json, 'checkpoint');
  if (rules === undefined) return { commit, filesChanged };
  const check = CheckpointRules.safeParse(rules);
  return { commit, filesChanged, rules: check.success ? check.data : { range: null, status: 'failed', error: CHECK_UNREAD } };
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
  return read(LensRead, json, 'lens');
}

/** The agent's words for a range; the app keeps them in its history, next to the range's newest snapshot. */
export async function sendLensWords(input: { repoPath: string; base: string | null; head: string; author: string; words: LensWords }): Promise<z.infer<typeof WordsWritten>> {
  const { status, json } = await request('/lens/words', input, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS, accept: [400, 404] });
  if (status === 404) throw new Error(APP_WITHOUT_LENS);
  if (status === 400) {
    const refused = failure(status, json);
    // An app older than linked words reads a body as text alone: it refuses pieces as not its words
    const pieces = input.words.steps?.some((step) => Array.isArray(step.body)) ?? false;
    throw pieces && refused.message.includes("Not the Lens's words") ? new Error(`${refused.message} ${APP_WITHOUT_PIECES}`) : refused;
  }
  return read(WordsWritten, json, 'lens');
}

/** A map answer, in the shapes this version reads. */
async function mapAnswer<S extends z.ZodType>(shape: S, route: string, body?: object): Promise<z.infer<S>> {
  const { status, json } = await request(route, body, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS, accept: [404] });
  if (status === 404) throw new Error(APP_WITHOUT_MAP);
  return read(shape, json, 'map');
}

/** The project's map, summed up; the app may draw the map in the request. */
export function readMap({ repoPath, aiTool }: { repoPath: string; aiTool: string }) {
  return mapAnswer(SummaryRead, `/map?${new URLSearchParams({ repoPath, aiTool })}`);
}

/** One area of the project's map, by its label or a folder path; the app may draw the map in the request. */
export function readArea({ repoPath, area, aiTool }: { repoPath: string; area: string; aiTool: string }) {
  return mapAnswer(AreaRead, `/map?${new URLSearchParams({ repoPath, area, aiTool })}`);
}

/** Where files and symbols sit and what depends on them; the app may draw the map in the request. */
export function readCodeContext(input: { repoPath: string; files?: string[]; symbols?: { name: string; file?: string }[]; aiTool: string }) {
  return mapAnswer(ContextRead, '/map/context', input);
}
