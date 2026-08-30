/**
 * Write a short overview for each story, with sources that are checked rather
 * than trusted.
 *
 * The design constraint agreed in PLAN.md §23 is that the model never supplies
 * a URL. A fabricated but authoritative-looking citation is worse than no
 * citation, because it is the part a reader is least able to check. Two source
 * classes satisfy that, and this pass uses both:
 *
 *   - **Curated identifiers from Wikidata** — the Wikipedia article we already
 *     store, plus Encyclopædia Britannica (P1417), present on 157 of the top
 *     200 narratives. Fetched here, never generated.
 *   - **URLs the model actually retrieved** — every URL appearing in a WebSearch
 *     or WebFetch result is recorded by the harness, and any citation not in
 *     that set is dropped before the file is written. The prompt asks; this
 *     enforces.
 *
 * Coverage honesty is part of the output, not a later addition. Each request is
 * told how many events sit beneath the story, and the schema requires the model
 * to say what it wrote from. A fluent paragraph beside an empty map otherwise
 * reads as "this is covered".
 *
 * Usage:
 *   npm run synthesize -- --top 20 --dry-run     # scope and cost, no calls
 *   npm run synthesize -- --top 20               # the 20 most notable
 *   npm run synthesize -- --min-events 5         # the agreed full scope
 *   npm run synthesize -- --qid 184536,9683      # named stories only
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { runStructured, AuthError, NoOutputError } from './lib/agent.ts';
import { sparql } from './lib/sparql.ts';
import type { Narrative } from '../src/lib/narratives.ts';
import type { EventRecord } from './lib/normalize.ts';

const NARRATIVES = 'public/data/narratives.json';
const EVENTS = 'public/data/events.json';
const OUT_DIR = 'data/raw/synthesis';

/** Per-story ceiling. Enforced by the SDK, not by hoping. */
const BUDGET_PER_STORY_USD = 0.6;
/** Whole-run ceiling. The run stops rather than exceeding it. */
const DEFAULT_RUN_BUDGET_USD = 5;
/** Modest: this is a background job competing with nothing. */
const CONCURRENCY = 3;
/** Events named in the prompt as evidence of what the dataset actually holds. */
const SAMPLE_EVENTS = 12;

export interface Source {
  url: string;
  title: string;
  /** How the URL was obtained. Only these three are ever written. */
  via: 'wikipedia' | 'britannica' | 'retrieved';
}

export interface Synthesis {
  q: number;
  n: string;
  /** Two or three paragraphs placing the story in the wider record. */
  overview: string;
  /** Why it mattered beyond its own time and place. */
  significance: string;
  /** What this was written from, including what the dataset lacks. */
  coverage: string;
  sources: Source[];
  /** Provenance of the text itself, so the UI never presents it as sourced. */
  model: string;
  costUsd: number;
  /** Citations the model offered that it had not actually retrieved. */
  rejectedUrls: string[];
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'significance', 'coverage', 'sources'],
  properties: {
    overview: {
      type: 'string',
      description:
        'Two or three paragraphs, plain prose, no headings or lists. What happened, ' +
        'where, and how it connects to the wider world of its time.',
    },
    significance: {
      type: 'string',
      description: 'One paragraph: why this mattered beyond its own time and place.',
    },
    coverage: {
      type: 'string',
      description:
        'One or two sentences naming what this was written from and what is thin or ' +
        'absent — in the dataset, and in the surviving record generally. Concrete, ' +
        'not a disclaimer.',
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'title'],
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
        },
      },
    },
  },
} as const;

const SYSTEM = `You write short, accurate historical overviews for a world history map.

Audience: a curious general reader. Plain prose. No headings, no bullet lists, no
markdown emphasis. Do not open with the subject's name as a definition ("The Mali
Empire was...") — assume the title is already on screen.

Two rules that matter more than style:

1. Never write a URL you have not retrieved in this session with WebSearch or
   WebFetch. Every URL you cite is checked against what you actually fetched, and
   any you did not retrieve is discarded. A source you half-remember is worse than
   no source. If you retrieve nothing, return an empty sources array.

2. Say what you do not know. Where the surviving record is thin, contested, or
   filtered through a hostile source, say so in the coverage field and reflect it
   in how confidently the overview reads. Do not smooth over a gap.

You are given the events this dataset holds for the story. They are a sample of
what the map can show, not the limit of what is known — but the coverage field
should be honest about the difference.`;

interface Curated {
  wikipedia?: string;
  britannica?: string;
}

/**
 * Curated links from Wikidata. Britannica is the reader-facing one; Wikipedia we
 * already store on the narrative.
 */
async function fetchCurated(qids: number[]): Promise<Map<number, Curated>> {
  const out = new Map<number, Curated>();
  for (let i = 0; i < qids.length; i += 100) {
    const values = qids.slice(i, i + 100).map((q) => `wd:Q${q}`).join(' ');
    const query = `
SELECT ?i ?britannica WHERE {
  VALUES ?i { ${values} }
  ?i wdt:P1417 ?britannica .
}`.trim();
    let bindings;
    try {
      bindings = await sparql(query);
    } catch (err) {
      console.log(`  curated-source lookup failed for one batch (${err instanceof Error ? err.message.slice(0, 60) : ''})`);
      continue;
    }
    for (const b of bindings) {
      const q = Number(b.i ? /Q(\d+)$/.exec(b.i.value)?.[1] : NaN);
      if (!Number.isFinite(q) || !b.britannica) continue;
      out.set(q, { britannica: `https://www.britannica.com/${b.britannica.value}` });
    }
  }
  return out;
}

const year = (v: number): string => (v < 0 ? `${Math.abs(v)} BCE` : String(v));

function buildPrompt(n: Narrative, beneath: EventRecord[], curated: Curated): string {
  const span = n.o ? `${year(n.s)} – end date not recorded` : `${year(n.s)} – ${year(n.e)}`;
  const sample = beneath
    .slice()
    .sort((a, b) => b.r - a.r)
    .slice(0, SAMPLE_EVENTS)
    .map((e) => `  - ${e.n} (${year(e.s)})`)
    .join('\n');

  const known = [
    curated.wikipedia && `  - Wikipedia: ${curated.wikipedia}`,
    curated.britannica && `  - Encyclopædia Britannica: ${curated.britannica}`,
  ]
    .filter(Boolean)
    .join('\n');

  return `Story: ${n.n}
Span: ${span}
${n.d ? `Wikidata description: ${n.d}\n` : ''}
Events this dataset holds beneath it: ${beneath.length}
${sample ? `Most notable of them:\n${sample}` : '  (none — the map can show no events for this story)'}

${known ? `Already-verified links you may cite without retrieving them:\n${known}\n` : ''}
Research this story with WebSearch and WebFetch, then write the overview,
significance, and coverage fields. Cite the verified links above plus anything
you actually retrieved. Keep the total to at most five sources, chosen for a
reader who wants to go deeper — reference works and institutional pages over news.`;
}

interface Scope {
  top?: number;
  minEvents?: number;
  qids?: number[];
  limit?: number;
  dryRun: boolean;
  runBudget: number;
}

function parseArgs(argv: string[]): Scope {
  const scope: Scope = { dryRun: false, runBudget: DEFAULT_RUN_BUDGET_USD };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === '--top') scope.top = Number(next());
    else if (arg === '--min-events') scope.minEvents = Number(next());
    else if (arg === '--qid') scope.qids = next().split(',').map((q) => Number(q.replace(/^Q/i, '')));
    else if (arg === '--limit') scope.limit = Number(next());
    else if (arg === '--budget') scope.runBudget = Number(next());
    else if (arg === '--dry-run') scope.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (scope.top === undefined && scope.minEvents === undefined && !scope.qids) {
    throw new Error('specify a scope: --top N, --min-events N, or --qid Q1,Q2 (see the header of this file)');
  }
  return scope;
}

function select(narratives: Narrative[], scope: Scope): Narrative[] {
  let pool = narratives;
  if (scope.qids) {
    const want = new Set(scope.qids);
    pool = pool.filter((n) => want.has(n.q));
  }
  if (scope.minEvents !== undefined) pool = pool.filter((n) => n.total >= scope.minEvents!);
  pool = pool.slice().sort((a, b) => b.r - a.r);
  if (scope.top !== undefined) pool = pool.slice(0, scope.top);
  // `--limit` is NOT applied here: it caps the work of one run, not the scope,
  // so it belongs after already-written stories are removed. Applying it here
  // made `--top 100 --limit 20` re-select the same finished twenty forever.
  return pool;
}

async function main(): Promise<void> {
  const scope = parseArgs(process.argv.slice(2));

  const narratives = JSON.parse(await readFile(NARRATIVES, 'utf8')) as Narrative[];
  const events = JSON.parse(await readFile(EVENTS, 'utf8')) as EventRecord[];

  // Membership, resolved the same way the client does: an event names its
  // parents, so invert rather than assume a stored member list.
  const beneathOf = new Map<number, EventRecord[]>();
  for (const e of events) {
    for (const p of e.pa ?? []) {
      const list = beneathOf.get(p) ?? [];
      list.push(e);
      beneathOf.set(p, list);
    }
  }

  const selected = select(narratives, scope);
  await mkdir(OUT_DIR, { recursive: true });
  const done = new Set(
    (await readdir(OUT_DIR).catch(() => [] as string[]))
      .filter((f) => f.endsWith('.json'))
      .map((f) => Number(f.replace('.json', ''))),
  );
  const remaining = selected.filter((n) => !done.has(n.q));
  const todo = scope.limit !== undefined ? remaining.slice(0, scope.limit) : remaining;

  console.log(
    `synthesize: ${selected.length} in scope, ${done.size} already written, ` +
      `${remaining.length} remaining${todo.length < remaining.length ? `, ${todo.length} this run (--limit)` : ''}`,
  );
  console.log(`  budget: $${BUDGET_PER_STORY_USD.toFixed(2)}/story, $${scope.runBudget.toFixed(2)} for the run\n`);

  if (todo.length === 0) {
    console.log('  nothing to do.');
    return;
  }

  // Fetched before the dry-run branch so `--dry-run` rehearses this path too —
  // a scope whose curated lookups all fail is worth knowing about before
  // spending anything.
  console.log('  fetching curated source identifiers from Wikidata...');
  const curated = await fetchCurated(todo.map((n) => n.q));
  console.log(`  ${curated.size} of ${todo.length} have a Britannica entry\n`);

  if (scope.dryRun) {
    console.log('  --dry-run: no model calls will be made. Stories in scope, most notable first:\n');
    for (const n of todo.slice(0, 30)) {
      console.log(
        `    rank ${String(n.r).padStart(3)}  ${String(beneathOf.get(n.q)?.length ?? 0).padStart(4)} events  ` +
          `${curated.has(n.q) ? 'EB ' : '   '}${n.n}`,
      );
    }
    if (todo.length > 30) console.log(`    ... and ${todo.length - 30} more`);
    console.log(
      `\n  Worst case at the per-story ceiling: $${(todo.length * BUDGET_PER_STORY_USD).toFixed(2)}. ` +
        `The run stops at $${scope.runBudget.toFixed(2)}.`,
    );
    return;
  }

  let spent = 0;
  let written = 0;
  let failed = 0;
  let rejectedTotal = 0;
  let stopped: string | null = null;

  const queue = [...todo];
  /**
   * Ceiling reservation.
   *
   * Checking `spent` alone lets every worker pass the gate and then spend up to
   * the per-story ceiling each — a $5 run finished at $6.21 on its first outing,
   * because three calls were already in flight when the limit was crossed.
   * Reserving the worst case before starting a call makes the stated ceiling
   * the actual one.
   */
  let reserved = 0;
  async function worker(): Promise<void> {
    while (queue.length > 0 && !stopped) {
      if (spent + reserved + BUDGET_PER_STORY_USD > scope.runBudget) {
        stopped = `run budget of $${scope.runBudget.toFixed(2)} would be exceeded by the next story`;
        return;
      }
      const n = queue.shift();
      if (!n) return;
      reserved += BUDGET_PER_STORY_USD;

      const beneath = beneathOf.get(n.q) ?? [];
      const links: Curated = { ...curated.get(n.q) };
      if (n.w) links.wikipedia = `https://en.wikipedia.org/wiki/${encodeURIComponent(n.w.replace(/ /g, '_'))}`;

      try {
        const run = await runStructured<{
          overview: string;
          significance: string;
          coverage: string;
          sources: { url: string; title: string }[];
        }>({
          prompt: buildPrompt(n, beneath, links),
          system: SYSTEM,
          schema: SCHEMA as unknown as Record<string, unknown>,
          tools: ['WebSearch', 'WebFetch'],
          budgetUsd: BUDGET_PER_STORY_USD,
        });
        spent += run.costUsd;

        // The check the prompt cannot make: a cited URL must be one we handed
        // over, or one the model demonstrably retrieved.
        const verified: Source[] = [];
        const rejected: string[] = [];
        for (const s of run.value.sources ?? []) {
          if (s.url === links.wikipedia) verified.push({ ...s, via: 'wikipedia' });
          else if (s.url === links.britannica) verified.push({ ...s, via: 'britannica' });
          else if (run.urlsSeen.has(s.url)) verified.push({ ...s, via: 'retrieved' });
          else rejected.push(s.url);
        }
        rejectedTotal += rejected.length;

        const out: Synthesis = {
          q: n.q,
          n: n.n,
          overview: run.value.overview,
          significance: run.value.significance,
          coverage: run.value.coverage,
          sources: verified,
          model: 'claude-opus-5',
          costUsd: Number(run.costUsd.toFixed(4)),
          rejectedUrls: rejected,
        };
        await writeFile(`${OUT_DIR}/${n.q}.json`, JSON.stringify(out, null, 2));
        written++;
        console.log(
          `  ✓ ${n.n.slice(0, 40).padEnd(42)} ${verified.length} sources` +
            `${rejected.length > 0 ? `, ${rejected.length} rejected` : ''}` +
            `  $${run.costUsd.toFixed(3)}  (spent $${spent.toFixed(2)})`,
        );
      } catch (err) {
        if (err instanceof AuthError) {
          stopped = `authentication failed — ${err.message}`;
          return;
        }
        failed++;
        const why = err instanceof NoOutputError ? err.message : err instanceof Error ? err.message : String(err);
        console.log(`  ✗ ${n.n.slice(0, 40).padEnd(42)} ${why.slice(0, 80)}`);
      } finally {
        // Exactly once, on every path — releasing inside `try` would double up
        // when the write throws after a successful call.
        reserved -= BUDGET_PER_STORY_USD;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

  console.log(`
--- synthesis complete ---
  written        ${written}
  failed         ${failed}
  spent          $${spent.toFixed(2)} of $${scope.runBudget.toFixed(2)}
  urls rejected  ${rejectedTotal} (cited but not retrieved)
  output         ${OUT_DIR}/`);
  if (stopped) console.log(`\n  STOPPED EARLY: ${stopped}`);
  if (rejectedTotal > 0) {
    console.log(`
  Rejected URLs are recorded per story in \`rejectedUrls\`. A non-zero count is
  the check working, not a failure — but a rising rate is worth reading.`);
  }
}

main().catch((err) => {
  console.error(err instanceof AuthError ? `\nauthentication failed: ${err.message}\n` : err);
  process.exit(1);
});
