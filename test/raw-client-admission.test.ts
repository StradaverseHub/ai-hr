import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';

const ROOT=new URL('..',import.meta.url).pathname;
const trackedSources=()=>execFileSync('git',['ls-files','app','lib','core','packs'],{cwd:ROOT,encoding:'utf8'})
 .split('\n').filter(file=>/\.(ts|tsx|mts)$/.test(file)&&!/\.test\./.test(file));
const RAW=/\b(client|appClient)(<[^`]*?>)?(`|\.unsafe\(|\.begin\(|\.reserve\(|\.file\()/;
/** The ways a raw client call may be bounded by admission. */
const ADMITTED=/withPoolWork|withSystemWork|withAuthReadConnection|authTransaction/;
const COMMENT_LINE=/^\s*(\*|\/\/)/;

describe('every raw postgres client query is admitted before it borrows a connection',()=>{
 it('keeps every runtime raw client call inside an admission wrapper',()=>{
  const offenders:string[]=[];
  for(const file of trackedSources()){
   const lines=readFileSync(ROOT+file,'utf8').split('\n');
   lines.forEach((line,index)=>{
    if(COMMENT_LINE.test(line)||!RAW.test(line)||ADMITTED.test(line))return;
    // A multi-line admitted template: the wrapper opens on one of the preceding lines.
    const preceding=lines.slice(Math.max(0,index-4),index).join(' ');
    if(/\b(withPoolWork|withSystemWork)\(/.test(preceding))return;
    offenders.push(`${file}:${index+1}: ${line.trim().slice(0,100)}`);
   });
  }
  expect(offenders).toEqual([]);
 });
 it('gives every raw query on the login path the authentication lane',()=>{
  for(const file of ['lib/request-budget.ts','lib/login-presentation-server.ts','lib/identity/session.ts','lib/internal-auth/invitations.ts','lib/internal-auth/recovery.ts','app/health/route.ts']){
   expect(readFileSync(ROOT+file,'utf8'),file).toMatch(/withPoolWork\('authentication'/);
  }
 });
 it('makes every deployed Node worker declare a counted connection budget',()=>{
  const units=execFileSync('git',['ls-files','deploy/systemd/*.service','deploy/entra/aihr-entra.service'],{cwd:ROOT,encoding:'utf8'}).split('\n').filter(Boolean);
  const nodeUnits=units.filter(unit=>/^ExecStart=.*\bnode\b.*--import tsx/m.test(readFileSync(ROOT+unit,'utf8')));
  expect(nodeUnits.length).toBeGreaterThanOrEqual(7);
  for(const unit of nodeUnits){
   const text=readFileSync(ROOT+unit,'utf8');
   expect(text,unit).toMatch(/^Environment=AIHR_DB_PROCESS_ROLE=worker$/m);
   expect(text,unit).toMatch(/^Environment=AIHR_DB_POOL_MAX=[1-8]$/m);
  }
 });
});
