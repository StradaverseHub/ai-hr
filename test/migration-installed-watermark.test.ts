/**
 * Every migration an installation has not applied is journalled above that installation's applied watermark.
 *
 * Drizzle's migrator applies only the journal entries whose `when` is greater than the last migration it recorded as
 * applied. An entry journalled at or below that watermark is skipped silently on that installation: the release
 * deploys, its schema change never runs, and nothing reports it (12 November 2026: a fix drafted as 5088, before
 * 5090, would have been skipped on staging, which had already applied 5090).
 *
 * INSTALLED is staging's applied ledger, recorded from release f7ee5177f: its 818 entries end at
 * 5090_audit_chain_commit_seal (when 1793330004790), and `tagsSha256` is the SHA-256 of their tags, in journal order,
 * joined by newlines. Update it only from the installation's actual ledger after an install, never to make a new
 * migration fit below the watermark.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';

type Entry={idx:number;when:number;tag:string};
const INSTALLED={name:'staging',watermark:1793330004790,count:818,tagsSha256:'935be4c295398c784c9a16704af210dc64d18e21eb6f8c2e164dff5cf55525e4'};

it('journals every migration the installation has not applied above its applied watermark',()=>{
 const entries=(JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:Entry[]}).entries;
 const applied=entries.filter(entry=>entry.when<=INSTALLED.watermark);
 const pending=entries.filter(entry=>entry.when>INSTALLED.watermark);
 const fingerprint=createHash('sha256').update(applied.map(entry=>entry.tag).join('\n')).digest('hex');
 // A new entry at or below the watermark changes this ledger: name it so the fix is obvious (journal it above).
 expect({count:applied.length,tagsSha256:fingerprint},
  `${INSTALLED.name} applied every entry through when ${INSTALLED.watermark}; a new entry at or below it would be skipped there. Journal it above, after ${applied.at(-1)?.tag}.`)
  .toEqual({count:INSTALLED.count,tagsSha256:INSTALLED.tagsSha256});
 // Pending entries keep strictly increasing `when` values after the watermark, in journal order.
 for(const [index,entry] of pending.entries())expect(entry.when).toBeGreaterThan(index===0?INSTALLED.watermark:pending[index-1]!.when);
});
