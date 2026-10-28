/** Append-only journal AND applied SQL bytes, compared to the PR's base commit. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
const JOURNAL = 'db/migrations/meta/_journal.json';
export function migrationProblems(before, after, previousSql, currentSql) {
  const problems = [];
  if (!Array.isArray(before) || !Array.isArray(after)) return ['Missing migration entries'];
  const tags = new Set(); let lastWhen = Math.max(-1, ...before.map(e => e.when)), lastIdx = Math.max(-1, ...before.map(e => e.idx));
  for (const [i, entry] of after.entries()) {
    if (!entry || !/^[a-zA-Z0-9_-]+$/.test(entry.tag) || tags.has(entry.tag) ||
        !Number.isSafeInteger(entry.when) || entry.when < 0 ||
        !Number.isSafeInteger(entry.idx) || entry.idx < 0 ||
        (i >= before.length && (entry.when <= lastWhen || entry.idx <= lastIdx))) {
      problems.push(`Invalid, duplicate or non-increasing migration entry ${i}`); continue;
    }
    tags.add(entry.tag); if (i >= before.length) { lastWhen = entry.when; lastIdx = entry.idx; }
    try {
      if (!currentSql(entry.tag).length) problems.push(`Empty SQL: ${entry.tag}`);
      if (i < before.length && !Buffer.from(previousSql(entry.tag)).equals(Buffer.from(currentSql(entry.tag)))) problems.push(`Applied SQL changed: ${entry.tag}`);
    } catch { problems.push(`Missing SQL: ${entry.tag}`); }
  }
  before.forEach((entry, i) => { if (!isDeepStrictEqual(entry, after[i])) problems.push(`Applied journal entry changed at index ${i}`); });
  return problems;
}
/** Owner-approved, centrally allocated correction of ONE never-applied canonical entry.
 * The 504 already-applied staging entries remain exact; this does not permit replay or SQL edits.
 * Exact source identities make this a single transition, not a general journal-reordering waiver.
 */
export function approvedEmailOrdering(before,after,previousSql,currentSql){
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 if(!Array.isArray(before)||!Array.isArray(after)||before.length!==504||after.length!==505
  ||hash(JSON.stringify(before))!=='70e8a8b00e45aed447f159cc29bf071852b9747e32268a9e007c7fc770029149')return false;
 const pending=before[503],email={idx:618,version:'7',when:1793109999999,tag:'0641_account_email_delivery_history',breakpoints:true};
 if(pending.tag!=='0640_onehr_plan_reviewer_scope'||pending.idx!==618||pending.when!==1793110000000
  ||!isDeepStrictEqual(after,[...before.slice(0,503),email,{...pending,idx:619}]))return false;
 try{
  const scope='0640_onehr_plan_reviewer_scope',mail='0641_account_email_delivery_history';
  return hash(previousSql(scope))==='1fdac0addc780e87dc5d44e44f8ec93fa184f350649bc95e2bac73d084c6284b'
   &&hash(currentSql(scope))==='1fdac0addc780e87dc5d44e44f8ec93fa184f350649bc95e2bac73d084c6284b'
   &&hash(currentSql(mail))==='855e984c18da0949f13ddd697d1b8b82c1ff646c04f701728e609f5972b8115d';
 }catch{return false;}
}
export function reviewedMigrationProblems(before,after,previousSql,currentSql){
 const approved=approvedEmailOrdering(before,after,previousSql,currentSql);
 return {approvedEmailOrdering:approved,problems:migrationProblems(approved?before.slice(0,503):before,after,previousSql,currentSql)};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.argv[2];
  if (!base || /^0+$/.test(base)) throw Error('An existing base commit is required');
  // Resolve a commit first, so untrusted ref text cannot become an option to git show.
  const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', base + '^{commit}'], {encoding:'utf8'}).trim();
  const previous = path => execFileSync('git', ['show', `${commit}:${path}`]);
  const before = JSON.parse(previous(JOURNAL).toString()).entries, after = JSON.parse(readFileSync(JOURNAL, 'utf8')).entries;
  const path = tag => `db/migrations/${tag}.sql`;
  const {problems,approvedEmailOrdering:approved} = reviewedMigrationProblems(before, after, tag => previous(path(tag)), tag => readFileSync(path(tag)));
  if(approved)console.log('Approved one-unapplied-entry correction: installed 0641 idx618 precedes pending 0640 idx619; both SQL bytes and 503 earlier entries remain unchanged.');
  if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
  else console.log(`Journal ${before.length} -> ${after.length}: applied entries and SQL unchanged; additions strictly increasing`);
}
