// One-off: write content/guides/i18n/titles.json from the translate-guides workflow output.
//   node scripts/merge-guide-titles.mjs <workflow-output.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outPath = process.argv[2];
if (!outPath) {
  console.error('usage: node scripts/merge-guide-titles.mjs <workflow-output.json>');
  process.exit(1);
}
const raw = JSON.parse(readFileSync(outPath, 'utf8'));
const titles = raw?.result?.titles ?? raw?.titles;
if (!titles) {
  console.error('No titles in workflow output');
  process.exit(1);
}

// Titles render as plain text (not Markdown), so decode the HTML entities the translators emitted.
const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
for (const slug of Object.keys(titles)) {
  for (const loc of Object.keys(titles[slug])) titles[slug][loc] = decode(titles[slug][loc]);
}

const dest = join(process.cwd(), 'content', 'guides', 'i18n', 'titles.json');
writeFileSync(dest, JSON.stringify(titles, null, 2) + '\n');
console.error(`Wrote ${Object.keys(titles).length} guide title sets → ${dest}`);
