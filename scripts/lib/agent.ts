/**
 * A small harness over the Claude Agent SDK.
 *
 * Authentication is the user's Claude Code OAuth session — the same credentials
 * `claude` uses interactively. No API key is read or required; the SDK resolves
 * the session itself. If that session has expired the run stops immediately
 * with an `AuthError` rather than burning through a work list producing
 * nothing (see `looksLikeAuthFailure` for why that needs its own check).
 *
 * Two properties this wrapper exists to guarantee:
 *
 *  1. **The model cannot touch the repository.** Only the tools passed in are
 *     permitted and `permissionMode: 'dontAsk'` denies everything else, so a
 *     synthesis pass cannot read, write, or execute anything locally.
 *  2. **Every URL the model saw is recorded.** Returned alongside the answer so
 *     the caller can reject citations that were not actually retrieved. A
 *     prompt asking for real URLs is a request; this is a check.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

/** The OAuth session is missing or expired. Not retryable; stop the run. */
export class AuthError extends Error {}

/** The model produced nothing usable after its retries. Skip this item. */
export class NoOutputError extends Error {}

export interface AgentRun<T> {
  value: T;
  /** Every URL that appeared in a tool result during the run. */
  urlsSeen: Set<string>;
  costUsd: number;
  turns: number;
}

export interface AgentRequest {
  prompt: string;
  system: string;
  /** JSON Schema the answer must validate against. */
  schema: Record<string, unknown>;
  /** Tool names to permit. Everything else is denied. */
  tools?: string[];
  /** Hard per-call spend ceiling, enforced by the SDK. */
  budgetUsd: number;
  maxTurns?: number;
  model?: string;
}

/**
 * An authentication failure arrives as a *successful* result whose text is an
 * error message — it does not throw, and `subtype` is still `'success'`. Left
 * unchecked, a 500-item run completes in seconds, costs nothing, and writes 500
 * files containing an error string.
 */
function looksLikeAuthFailure(text: string): boolean {
  return /Failed to authenticate|OAuth .*(revoked|expired)|401/i.test(text);
}

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]}\\]+/g;

/** Strip the trailing punctuation that sentence context leaves on a URL. */
export function collectUrls(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.match(URL_PATTERN) ?? []) {
      into.add(match.replace(/[.,;:!?]+$/, ''));
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectUrls(item, into);
  }
}

export async function runStructured<T>(req: AgentRequest): Promise<AgentRun<T>> {
  const urlsSeen = new Set<string>();
  let costUsd = 0;
  let turns = 0;

  const stream = query({
    prompt: req.prompt,
    options: {
      model: req.model ?? 'claude-opus-5',
      systemPrompt: req.system,
      allowedTools: req.tools ?? [],
      // Nothing outside `allowedTools` runs, and nothing prompts: this is a
      // batch job with no one at the keyboard to answer.
      permissionMode: 'dontAsk',
      // Do not load CLAUDE.md, project skills, or user settings. The harness
      // must behave the same on any machine, and this repo's instructions are
      // about writing code, not about writing history.
      settingSources: [],
      outputFormat: { type: 'json_schema', schema: req.schema },
      maxTurns: req.maxTurns ?? 12,
      maxBudgetUsd: req.budgetUsd,
    },
  });

  let structured: unknown;
  let resultText = '';
  let subtype = '';

  for await (const message of stream) {
    // Tool results come back on user messages; scan the whole message so a
    // change in block shape does not silently stop URL collection.
    if (message.type === 'user') {
      collectUrls(message.message.content, urlsSeen);
      if (message.tool_use_result !== undefined) collectUrls(message.tool_use_result, urlsSeen);
    }
    if (message.type === 'result') {
      subtype = message.subtype;
      costUsd = message.total_cost_usd;
      turns = message.num_turns;
      if (message.subtype === 'success') {
        structured = message.structured_output;
        resultText = message.result;
      } else {
        resultText = message.errors?.join('; ') ?? message.subtype;
      }
    }
  }

  if (looksLikeAuthFailure(resultText)) {
    throw new AuthError(resultText.trim());
  }
  if (structured === undefined || structured === null) {
    throw new NoOutputError(`no structured output (${subtype || 'no result'}): ${resultText.slice(0, 200)}`);
  }

  return { value: structured as T, urlsSeen, costUsd, turns };
}
