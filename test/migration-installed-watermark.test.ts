/**
 * Every migration an installation has not applied is journalled above that installation's applied watermark.
 *
 * Drizzle's migrator applies only the journal entries whose `when` is greater than the last migration it recorded as
 * applied. An entry journalled at or below that watermark is skipped silently on that installation: the release
 * deploys, its schema change never runs, and nothing reports it (12 November 2026: a fix drafted as 5088, before
 * 5090, would have been skipped on staging, which had already applied 5090).
 *
 * INSTALLED records each installation's applied ledger:
 * - staging: from release f7ee5177f, whose 818 entries end at 5090_audit_chain_commit_seal (when 1793330004790).
 *   `tagsSha256` is the SHA-256 of their tags, in journal order, joined by newlines.
 * - production: read read-only from its migration ledger on 12 November 2026: 697 rows, last 2300 (created_at
 *   1793330001700). `ledgerSha256` is the SHA-256 of `<hash> <created_at>` lines sorted by created_at, then hash,
 *   joined by newlines; each hash is the SHA-256 of the migration file's bytes, as Drizzle records it.
 * Update an entry only from the installation's actual ledger after an install, never to make a new migration fit
 * below a watermark.
 *
 * RESERVED records numbers other sessions hold above staging's watermark (release coordinator, 12 November 2026;
 * tag 51NN, when 17933300048NN): the Irwin release's 5100, 5101, 5102 and 5110-5112 (when 1793330004800-1793330004812)
 * and PR 240's 5122 (when 1793330004822). The Irwin release may reach staging before this one and raise its watermark
 * to 1793330004812, so every other pending entry is journalled above it. No other entry takes a reserved number or
 * `when`, and a reserved migration merged here keeps its reserved `when`.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

type Entry={idx:number;when:number;tag:string};
type Installed={name:string;watermark:number;count:number;tagsSha256?:string;ledgerSha256?:string};
const INSTALLED:Installed[]=[
 {name:'staging',watermark:1793330004790,count:818,tagsSha256:'935be4c295398c784c9a16704af210dc64d18e21eb6f8c2e164dff5cf55525e4'},
 {name:'production (read 12 Nov 2026)',watermark:1793330001700,count:697,ledgerSha256:'a3335110203a291c6733fd6ee2252561ea4a91a1135ac4d7ea7da12cc54abb93'},
];
type Reserved={number:number;owner:string;first:boolean;when:number};
const RESERVED:readonly Reserved[]=[
 ...[5100,5101,5102,5110,5111,5112].map(number=>({number,owner:'the Irwin release',first:true})),
 {number:5122,owner:'PR 240',first:false},
].map(reserved=>({...reserved,when:1793330004800+(reserved.number-5100)}));
const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const entries=(JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:Entry[]}).entries;

describe('installed migration watermarks',()=>{
 for(const installed of INSTALLED)it(`journals every migration ${installed.name} has not applied above its applied watermark`,()=>{
  const applied=entries.filter(entry=>entry.when<=installed.watermark);
  const pending=entries.filter(entry=>entry.when>installed.watermark);
  const ledger=()=>applied.map(entry=>({when:entry.when,hash:sha256(readFileSync(`db/migrations/${entry.tag}.sql`))}))
   .sort((left,right)=>left.when-right.when||(left.hash<right.hash?-1:left.hash>right.hash?1:0))
   .map(row=>`${row.hash} ${row.when}`).join('\n');
  // A new entry at or below the watermark changes this ledger: name it so the fix is obvious (journal it above).
  expect({
   count:applied.length,
   ...(installed.tagsSha256?{tagsSha256:sha256(applied.map(entry=>entry.tag).join('\n'))}:{}),
   ...(installed.ledgerSha256?{ledgerSha256:sha256(ledger())}:{}),
  },`${installed.name} applied every entry through when ${installed.watermark}; a new entry at or below it would be skipped there. Journal it above, after ${applied.at(-1)?.tag}.`)
   .toEqual({
    count:installed.count,
    ...(installed.tagsSha256?{tagsSha256:installed.tagsSha256}:{}),
    ...(installed.ledgerSha256?{ledgerSha256:installed.ledgerSha256}:{}),
   });
  // Pending entries keep strictly increasing `when` values after the watermark, in journal order.
  for(const [index,entry] of pending.entries())expect(entry.when).toBeGreaterThan(index===0?installed.watermark:pending[index-1]!.when);
 });
 it('journals every other pending migration above the numbers other sessions reserved',()=>{
  const ceiling=Math.max(...RESERVED.filter(reserved=>reserved.first).map(reserved=>reserved.when));
  for(const entry of entries.filter(entry=>entry.when>INSTALLED[0]!.watermark)){
   const reserved=RESERVED.find(candidate=>entry.tag.startsWith(`${candidate.number}_`));
   if(reserved){expect(entry.when,`${entry.tag} keeps ${reserved.owner}'s reserved when`).toBe(reserved.when);continue;}
   const taken=RESERVED.find(candidate=>candidate.when===entry.when);
   expect(taken,`${entry.tag} takes the when ${entry.when} reserved for ${taken?.owner}'s ${taken?.number}`).toBeUndefined();
   expect(entry.when,`${entry.tag} would be skipped wherever a reserved migration (up to when ${ceiling}) is applied first. Journal it above.`).toBeGreaterThan(ceiling);
  }
 });
});
