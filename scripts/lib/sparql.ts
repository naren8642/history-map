/**
 * Minimal WDQS client: polite, serialized, retrying.
 *
 * WDQS enforces a hard ~60s server-side timeout. We treat a timeout as a
 * *signal to split the date range*, not as a failure — see chunk.ts. So the
 * timeout case gets its own error type rather than being folded into retries.
 */

const ENDPOINT = 'https://query.wikidata.org/sparql';

// Wikimedia's UA policy asks for a descriptive agent with a contact address.
const USER_AGENT = 'history-map-harvest/0.1 (https://github.com/naren/history-map; naren.salem@gmail.com)';

/** Client-side abort, set just under the server's own ~60s limit. */
const CLIENT_TIMEOUT_MS = 55_000;

/** Wikimedia asks for serial, not parallel, access. One request per second. */
const MIN_REQUEST_GAP_MS = 1_500;

const MAX_RETRIES = 5;

export type Binding = Record<string, { value: string; type: string; datatype?: string }>;

/**
 * The response was unusable in a way that a *smaller date range* would fix.
 * Callers should bisect and retry rather than treating this as a hard failure.
 */
export class SplittableError extends Error {}

/** The query exceeded the time budget. */
export class QueryTimeout extends SplittableError {
  constructor(msg: string) {
    super(msg);
    this.name = 'QueryTimeout';
  }
}

/**
 * WDQS sent HTTP 200 with a body that cut off mid-JSON. Observed on dense
 * decades: the server starts streaming, hits an internal limit, and closes.
 * There is no error status and no marker in the body — the only evidence is
 * that the JSON does not parse. Left unhandled this silently drops a range.
 */
export class TruncatedResponse extends SplittableError {
  constructor(msg: string) {
    super(msg);
    this.name = 'TruncatedResponse';
  }
}

let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * WDQS signals timeouts inconsistently: sometimes HTTP 500 with a Java stack
 * trace, sometimes HTTP 200 with an empty body. Both were observed while
 * profiling this dataset, so we check for both.
 */
function looksLikeTimeout(status: number, body: string): boolean {
  if (body.trim() === '') return true;
  if (status >= 500 && /timeout|TimeoutException|QueryTimeout/i.test(body)) return true;
  return false;
}

export async function sparql(query: string): Promise<Binding[]> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await throttle();

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

    try {
      const res = await fetch(`${ENDPOINT}?query=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json' },
        signal: controller.signal,
      });

      const body = await res.text();

      /*
       * Status is checked before the timeout heuristic, not after.
       *
       * WDQS returns 429 with an empty body when rate limiting, and the
       * heuristic treats an empty body as a timeout — so a rate limit was
       * being reported as "WDQS timed out (HTTP 429)" and propagated straight
       * past the backoff that exists to handle it.
       */
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        lastError = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        if (attempt < MAX_RETRIES) {
          // Honour Retry-After; otherwise back off with jitter so retries do
          // not resynchronise into the same limit.
          await sleep(
            retryAfter > 0
              ? retryAfter * 1000
              : 5_000 * 2 ** (attempt - 1) * (1 + Math.random()),
          );
          continue;
        }
        throw lastError;
      }

      if (looksLikeTimeout(res.status, body)) {
        throw new QueryTimeout(`WDQS timed out (HTTP ${res.status})`);
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);

      try {
        return JSON.parse(body).results.bindings as Binding[];
      } catch {
        throw new TruncatedResponse(
          `unparseable body (${body.length} bytes) — likely truncated mid-stream`,
        );
      }
    } catch (err) {
      clearTimeout(abortTimer);

      // Our own abort means the query was too slow — same meaning as a server timeout.
      if (err instanceof Error && err.name === 'AbortError') {
        throw new QueryTimeout(`client abort after ${CLIENT_TIMEOUT_MS}ms`);
      }
      // Truncation has been observed to be transient: the same range that
      // failed mid-stream succeeded on a clean retry. Retrying is much cheaper
      // than bisecting, so only escalate to the splitter once retries run out.
      if (err instanceof TruncatedResponse && attempt < MAX_RETRIES) {
        lastError = err;
        await sleep(2 ** attempt * 1000);
        continue;
      }
      if (err instanceof SplittableError) throw err;

      lastError = err;
      if (attempt < MAX_RETRIES) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(abortTimer);
    }
  }

  throw lastError ?? new Error('sparql: exhausted retries');
}
