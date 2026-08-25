/**
 * r220 (item 61c2e30f) — write `docs/forms/ea-cp8a-field-register.md` from `lib/ea-field-register.ts`.
 *
 *   pnpm tsx scripts/gen-ea-field-register.ts
 *
 * The document is CHECKED IN rather than generated at read time so it can be reviewed in a diff like any
 * other file — a caption quietly changing wording should show up in a pull request, which is the whole
 * point of the register. `test/ea-form-boxes-contract.test.ts` fails when the checked-in copy and this
 * generator disagree, so it cannot be forgotten.
 *
 * No database, no environment, no network: the register is a pure constant over the renderer's own
 * captions. That is also why the download route serves `renderEaFieldRegisterMarkdown()` directly rather
 * than reading this file off disk — `docs/` does not have to reach the server for the shelf to work.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderEaFieldRegisterMarkdown } from '../lib/ea-field-register';

const OUT = path.resolve(__dirname, '..', 'docs/forms/ea-cp8a-field-register.md');
writeFileSync(OUT, renderEaFieldRegisterMarkdown(), 'utf8');
console.log(`wrote ${OUT}`);
