/**
 * Publish the synthesis store to `public/`.
 *
 * One file per story rather than the QID-sharded layout the summary store uses.
 * The access patterns differ: summaries are clicked rapidly while scanning a
 * cluster, so a shard covering many later clicks pays for itself. A story is
 * entered deliberately, one at a time, and its overview is ~5 KB — so a single
 * fetch on entry is both simpler and less to ship, and stays that way at 849
 * stories.
 *
 * `index.json` lists which stories have an overview, so the UI can mark them
 * without probing for 404s.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import type { Synthesis } from './synthesize.ts';

const IN_DIR = 'data/raw/synthesis';
const OUT_DIR = 'public/data/synthesis';

async function main(): Promise<void> {
  let files: string[];
  try {
    files = (await readdir(IN_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    console.log(`stage-synthesis: no ${IN_DIR} — nothing to publish (run \`npm run synthesize\`)`);
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  const qids: number[] = [];
  let sources = 0;
  let rejected = 0;

  for (const file of files) {
    const record = JSON.parse(await readFile(`${IN_DIR}/${file}`, 'utf8')) as Synthesis;
    // `rejectedUrls` and `costUsd` are provenance for us, not for the reader.
    // They stay in data/raw and out of the shipped file.
    const { rejectedUrls, costUsd, ...published } = record;
    void rejectedUrls;
    void costUsd;
    await writeFile(`${OUT_DIR}/${record.q}.json`, JSON.stringify(published));
    qids.push(record.q);
    sources += record.sources.length;
    rejected += record.rejectedUrls.length;
  }

  qids.sort((a, b) => a - b);
  await writeFile(`${OUT_DIR}/index.json`, JSON.stringify(qids));

  console.log(`stage-synthesis: ${qids.length} stories, ${sources} sources published`);
  if (rejected > 0) {
    console.log(`  (${rejected} unverified citations were dropped at synthesis time)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
