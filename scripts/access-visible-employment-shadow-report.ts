/**
 * ADR 0181, employment visibility shadow (migration 7240): count the shadow lines in PostgreSQL logs, per day, against
 * the owner's minimum (core/access-visible-employment-shadow-report.ts). Counts only: no log text is printed.
 *
 *   node --import tsx scripts/access-visible-employment-shadow-report.ts /var/log/postgresql/postgresql-*-main.log*
 *   node --import tsx scripts/access-visible-employment-shadow-report.ts --through=2026-12-02 --days=7 <files...>
 *   sudo cat /var/log/postgresql/postgresql-16-main.log | node --import tsx scripts/access-visible-employment-shadow-report.ts -
 *
 * Rotated `.gz` files are read through gunzip; `-` reads standard input. The window is the seven days ending on
 * --through (default: the latest dated day found). It needs no database connection and no environment file.
 *
 * Exit codes: 0 read, no compared call differed (the minimum may or may not be met yet; the report says) · 3 at least
 * one compared call had missing or extra employments · 2 a file could not be read, or bad arguments.
 */
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {createGunzip} from 'node:zlib';
import type {Readable} from 'node:stream';
import {ShadowTally,evaluateShadow,formatShadowReport,shadowReportExitCode} from '../core/access-visible-employment-shadow-report';

async function feed(tally:ShadowTally,input:Readable){
 for await(const line of createInterface({input,crlfDelay:Infinity}))tally.add(line);
}

async function main(){
 const args=process.argv.slice(2);
 const option=(name:string)=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
 const through=option('through'),days=option('days');
 if(through!==undefined&&!/^\d{4}-\d{2}-\d{2}$/.test(through)){console.error('--through must be YYYY-MM-DD');process.exit(2);}
 if(days!==undefined&&!/^[1-9]\d?$/.test(days)){console.error('--days must be 1..99');process.exit(2);}
 const files=args.filter(a=>!a.startsWith('--'));
 if(files.length===0){console.error('usage: access-visible-employment-shadow-report.ts [--through=YYYY-MM-DD] [--days=7] <log file|->...');process.exit(2);}
 const tally=new ShadowTally();
 let unreadable=0;
 for(const file of files){
  try{
   if(file==='-'){await feed(tally,process.stdin);continue;}
   const stream=createReadStream(file);
   await feed(tally,file.endsWith('.gz')?stream.pipe(createGunzip()):stream);
  }catch(error){unreadable++;console.error(`could not read a log file (${(error as {code?:string}).code??(error as Error).name}): ${file}`);}
 }
 const evaluation=evaluateShadow(tally.days(),{through,days:days===undefined?undefined:Number(days)});
 for(const line of formatShadowReport(tally,evaluation))console.log(line);
 process.exitCode=unreadable>0?2:shadowReportExitCode(evaluation);
}
main().catch(error=>{console.error(`shadow report failed: ${(error as Error).name}`);process.exit(2);});
