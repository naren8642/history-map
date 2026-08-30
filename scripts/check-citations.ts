/** The citation check is the whole guarantee; exercise it without the network. */
import { collectUrls } from './lib/agent.ts';

// Shaped like a real WebSearch tool_result reaching the harness on a user message.
const toolResult = [
  {
    type: 'tool_result',
    tool_use_id: 'toolu_1',
    content: [
      {
        type: 'text',
        text: 'Results:\n1. "Mali Empire" — https://www.britannica.com/place/Mali-historical-empire-Africa\n' +
              '2. UNESCO listing (https://whc.unesco.org/en/list/116).\n' +
              '3. See https://en.wikipedia.org/wiki/Mali_Empire for an overview.',
      },
    ],
  },
];

const seen = new Set<string>();
collectUrls(toolResult, seen);
console.log('collected:');
for (const u of [...seen].sort()) console.log('  ' + u);

const expected = [
  'https://www.britannica.com/place/Mali-historical-empire-Africa',
  'https://whc.unesco.org/en/list/116',
  'https://en.wikipedia.org/wiki/Mali_Empire',
];
const missing = expected.filter((u) => !seen.has(u));
const fabricated = 'https://www.jstor.org/stable/000000';
console.log('\nall three collected, punctuation stripped:', missing.length === 0 ? 'PASS' : `FAIL — missed ${missing}`);
console.log('a URL never retrieved is not in the set:  ', seen.has(fabricated) ? 'FAIL' : 'PASS');
console.log('nothing extra collected:                  ', seen.size === 3 ? 'PASS' : `FAIL — ${seen.size} urls`);
