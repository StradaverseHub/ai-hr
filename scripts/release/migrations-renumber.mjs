/** ADR-0175 decision 6: number unapplied migrations at landing. Dry run by default.
 *
 *   node scripts/release/migrations-renumber.mjs [--base origin/main] [--staging-watermark WHEN]
 *        [--start-file N] [--write]
 *
 * Only entries AFTER the base journal's exact prefix move. Applied entries, their SQL bytes and their order
 * are never touched: if the base journal is not an exact prefix of HEAD's, merge the base first (refuses).
 * New positions: idx and `when` continue strictly above the base (and the recorded staging watermark, since a
 * lower `when` is silently skipped by the migrator); the file number continues above the base's highest.
 * SQL content is unchanged (only the file is renamed), so SQL hashes stay the same. Every other file that
 * names an old tag is listed for the owner of that file to update, together with MIGRATION-ALLOCATION.md.
 * The populated-upgrade rehearsal and the affected tests must still run after renumbering. */
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const JOURNAL='db/migrations/meta/_journal.json';
const numberOf=tag=>{const m=/^(\d+)_/.exec(tag);return m?Number(m[1]):null;};

export function renumberPlan(baseEntries,headEntries,{stagingWatermark=null,startFile=null}={}){
  baseEntries.forEach((entry,i)=>{
    const h=headEntries[i];
    if(!h||h.tag!==entry.tag||h.when!==entry.when||h.idx!==entry.idx)throw Error(`Base journal entry ${i} (${entry.tag}) is not an exact prefix of HEAD: merge the base before renumbering`);
  });
  const pending=headEntries.slice(baseEntries.length);
  let idx=Math.max(-1,...baseEntries.map(e=>e.idx)),when=Math.max(-1,...baseEntries.map(e=>e.when),stagingWatermark??-1);
  let file=startFile??Math.max(0,...baseEntries.map(e=>numberOf(e.tag)??0))+1;
  const width=Math.max(4,...headEntries.map(e=>(/^(\d+)_/.exec(e.tag)?.[1]??'').length));
  const used=new Set(baseEntries.map(e=>numberOf(e.tag)));
  return pending.map(entry=>{
    while(used.has(file))file++;
    const suffix=entry.tag.replace(/^\d+_/,'');
    const next={...entry,idx:++idx,when:++when,tag:`${String(file).padStart(width,'0')}_${suffix}`};
    used.add(file++);
    return {from:{tag:entry.tag,idx:entry.idx,when:entry.when},to:{tag:next.tag,idx:next.idx,when:next.when},entry:next};
  });
}

function main(){
  const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
  const base=option('--base')??'origin/main',write=args.includes('--write');
  const git=(a,o={})=>execFileSync('git',a,{encoding:'utf8',maxBuffer:64*1024**2,...o});
  if(write&&git(['status','--porcelain']).trim())throw Error('Commit or set aside other changes first: --write needs a clean tree so the renumbering is one reviewable commit');
  const baseJournal=JSON.parse(git(['show',`${base}:${JOURNAL}`])),head=JSON.parse(readFileSync(JOURNAL,'utf8'));
  const plan=renumberPlan(baseJournal.entries,head.entries,{
    stagingWatermark:option('--staging-watermark')==null?null:Number(option('--staging-watermark')),
    startFile:option('--start-file')==null?null:Number(option('--start-file')),
  });
  const moves=plan.filter(p=>p.from.tag!==p.to.tag||p.from.idx!==p.to.idx||p.from.when!==p.to.when);
  console.log(`${plan.length} unapplied migration(s) after ${base}'s ${baseJournal.entries.length}-entry prefix; ${moves.length} would move.`);
  for(const p of plan)console.log(`  ${p.from.tag} idx ${p.from.idx} when ${p.from.when}  ->  ${p.to.tag} idx ${p.to.idx} when ${p.to.when}`);
  const mentions=new Map();
  for(const p of moves.filter(m=>m.from.tag!==m.to.tag)){
    let files=[];try{files=git(['grep','-l','-F',p.from.tag]).trim().split('\n').filter(Boolean);}catch{/* no mentions */}
    mentions.set(p.from.tag,files.filter(f=>f!==JOURNAL&&f!==`db/migrations/${p.from.tag}.sql`));
  }
  for(const [tag,files]of mentions)if(files.length)console.log(`  files naming ${tag} (update by their owners): ${files.join(', ')}`);
  if(!write){console.log(moves.length?'Dry run: re-run with --write to apply.':'Nothing to renumber.');return;}
  for(const p of moves)if(p.from.tag!==p.to.tag){
    if(existsSync(`db/migrations/${p.to.tag}.sql`))throw Error('Target SQL already exists: '+p.to.tag);
    git(['mv',`db/migrations/${p.from.tag}.sql`,`db/migrations/${p.to.tag}.sql`]);
  }
  const entries=[...head.entries.slice(0,baseJournal.entries.length),...plan.map(p=>p.entry)];
  writeFileSync(JOURNAL,JSON.stringify({...head,entries},null,2)+'\n');
  console.log('Journal and SQL file names updated. Next: update the files listed above and MIGRATION-ALLOCATION.md, then run the populated upgrade and affected tests.');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main();
