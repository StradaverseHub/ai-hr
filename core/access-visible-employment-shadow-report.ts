/** ADR 0181, employment visibility (migration 7240): count the shadow lines in a PostgreSQL log against the owner's
 * minimum (docs/adr/0181-addendum-precomputed-employment-visibility.md section 10 decision 5): 20,000
 * `reason=compared` reader calls in seven days, of which at least 2,000 have `relationship=1`, with zero unexplained
 * differences.
 *
 * Each call of app.access_visible_employment_ids() in `shadow` logs exactly one line:
 *   access_visible_employment shadow missing=<n> extra=<n> relationship=<0|1> reason=<compared|untrusted|stale|...>
 * The line carries counts only, and this report keeps it that way: it reads the date at the start of the log line
 * (as the server wrote it, in its log_timezone), the four fields, and nothing else. No other log text is kept or
 * printed. Pure; scripts/access-visible-employment-shadow-report.ts feeds it log files. */

export const SHADOW_MINIMUM={compared:20_000,relationship:2_000,days:7} as const;
const MARKER='access_visible_employment shadow ';
const FIELDS=/\b(missing|extra|relationship|reason)=([A-Za-z0-9_]+)/g;
const STAMP=/^(\d{4}-\d{2}-\d{2})[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?: ?([A-Z]{2,5}|[+-]\d{2}(?::?\d{2})?|Z))?/;

export type ShadowLine={day:string|null;zone:string|null;reason:string;relationship:0|1;missing:number;extra:number};
export type ShadowDay={day:string;compared:number;relationship1:number;relationship0:number;missing:number;extra:number;
 differingCalls:number;other:Record<string,number>};

/** One log line to its counts, or null when it is not a 7240 shadow line. Field order does not matter. */
export function parseShadowLine(line:string):ShadowLine|null{
 const at=line.indexOf(MARKER);
 if(at<0)return null;
 const fields:Record<string,string>={};
 for(const m of line.slice(at+MARKER.length).matchAll(FIELDS))fields[m[1]]??=m[2];
 const {missing,extra,relationship,reason}=fields;
 if(reason===undefined||!/^[01]$/.test(relationship??'')||!/^\d+$/.test(missing??'')||!/^\d+$/.test(extra??''))return null;
 const stamp=STAMP.exec(line);
 return{day:stamp?.[1]??null,zone:stamp?.[2]??null,reason,relationship:relationship==='1'?1:0,missing:Number(missing),extra:Number(extra)};
}

const UNDATED='undated';
const dayNumber=(day:string)=>Date.UTC(Number(day.slice(0,4)),Number(day.slice(5,7))-1,Number(day.slice(8,10)))/86_400_000;
const dayOf=(n:number)=>new Date(n*86_400_000).toISOString().slice(0,10);

export class ShadowTally{
 private readonly byDay=new Map<string,ShadowDay>();
 readonly zones=new Set<string>();
 linesRead=0;
 add(line:string):void{
  this.linesRead++;
  const parsed=parseShadowLine(line);
  if(!parsed)return;
  if(parsed.zone)this.zones.add(parsed.zone);
  const key=parsed.day??UNDATED;
  let d=this.byDay.get(key);
  if(!d)this.byDay.set(key,d={day:key,compared:0,relationship1:0,relationship0:0,missing:0,extra:0,differingCalls:0,other:{}});
  if(parsed.reason!=='compared'){d.other[parsed.reason]=(d.other[parsed.reason]??0)+1;return;}
  d.compared++;
  if(parsed.relationship===1)d.relationship1++;else d.relationship0++;
  d.missing+=parsed.missing;d.extra+=parsed.extra;
  if(parsed.missing+parsed.extra>0)d.differingCalls++;
 }
 /** Dated days in order, then the undated bucket if any. */
 days():ShadowDay[]{
  const dated=[...this.byDay.values()].filter(d=>d.day!==UNDATED).sort((a,b)=>a.day.localeCompare(b.day));
  const undated=this.byDay.get(UNDATED);
  return undated?[...dated,undated]:dated;
 }
}

export type ShadowEvaluation={from:string|null;through:string|null;days:number;compared:number;relationship1:number;missing:number;extra:number;
 differingCalls:number;other:Record<string,number>;comparedMet:boolean;relationshipMet:boolean;minimumMet:boolean;
 differencesAnywhere:number;undatedLines:number};

/** The seven-day window ending on `through` (default: the latest dated day in the log), against the minimum.
 * `differencesAnywhere` counts differing calls on every day read, inside the window or not. */
export function evaluateShadow(days:readonly ShadowDay[],opts:{through?:string;days?:number}={}):ShadowEvaluation{
 const span=opts.days??SHADOW_MINIMUM.days;
 const dated=days.filter(d=>d.day!==UNDATED);
 const through=opts.through??dated[dated.length-1]?.day??null;
 const from=through?dayOf(dayNumber(through)-(span-1)):null;
 const inWindow=dated.filter(d=>from!==null&&through!==null&&d.day>=from&&d.day<=through);
 const sum=(f:(d:ShadowDay)=>number)=>inWindow.reduce((n,d)=>n+f(d),0);
 const other:Record<string,number>={};
 for(const d of inWindow)for(const[k,v]of Object.entries(d.other))other[k]=(other[k]??0)+v;
 const compared=sum(d=>d.compared),relationship1=sum(d=>d.relationship1);
 const undated=days.find(d=>d.day===UNDATED);
 return{from,through,days:span,compared,relationship1,missing:sum(d=>d.missing),extra:sum(d=>d.extra),differingCalls:sum(d=>d.differingCalls),other,
  comparedMet:compared>=SHADOW_MINIMUM.compared,relationshipMet:relationship1>=SHADOW_MINIMUM.relationship,
  minimumMet:compared>=SHADOW_MINIMUM.compared&&relationship1>=SHADOW_MINIMUM.relationship,
  differencesAnywhere:days.reduce((n,d)=>n+d.differingCalls,0),
  undatedLines:undated?undated.compared+Object.values(undated.other).reduce((a,b)=>a+b,0):0};
}

const n=(x:number)=>x.toLocaleString('en-US');
const pad=(s:string,w:number)=>s.padStart(w);

export function formatShadowReport(tally:ShadowTally,evaluation:ShadowEvaluation):string[]{
 const zones=[...tally.zones].sort();
 const out=[`access_visible_employment shadow report (counts only; days as the log wrote them${zones.length?`, zone ${zones.join('/')}`:''}; ${n(tally.linesRead)} log lines read)`];
 out.push(`${'day'.padEnd(10)} ${pad('compared',9)} ${pad('relationship=1',14)} ${pad('relationship=0',14)} ${pad('missing',8)} ${pad('extra',8)} ${pad('differing',9)}  other reasons`);
 for(const d of tally.days()){
  const other=Object.entries(d.other).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${n(v)}`).join(' ')||'-';
  out.push(`${d.day.padEnd(10)} ${pad(n(d.compared),9)} ${pad(n(d.relationship1),14)} ${pad(n(d.relationship0),14)} ${pad(n(d.missing),8)} ${pad(n(d.extra),8)} ${pad(n(d.differingCalls),9)}  ${other}`);
 }
 if(evaluation.through===null){out.push('no dated shadow lines: the window cannot be evaluated');return out;}
 const met=(b:boolean)=>b?'met':'not met';
 out.push(`window ${evaluation.from}..${evaluation.through} (${evaluation.days} days): compared ${n(evaluation.compared)} / ${n(SHADOW_MINIMUM.compared)} (${met(evaluation.comparedMet)}),`+
  ` relationship=1 ${n(evaluation.relationship1)} / ${n(SHADOW_MINIMUM.relationship)} (${met(evaluation.relationshipMet)}),`+
  ` missing ${n(evaluation.missing)}, extra ${n(evaluation.extra)}, calls with differences ${n(evaluation.differingCalls)}`);
 const other=Object.entries(evaluation.other).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${n(v)}`).join(' ');
 if(other)out.push(`not compared in the window (fallback reasons, not differences): ${other}`);
 if(evaluation.undatedLines>0)out.push(`${n(evaluation.undatedLines)} shadow lines had no leading date and are outside the window`);
 out.push(evaluation.differencesAnywhere>0
  ?`DIFFERENCES: ${n(evaluation.differencesAnywhere)} compared calls had missing or extra employments; each needs an explanation before the period counts`
  :'no compared call had a difference');
 out.push(`minimum ${met(evaluation.minimumMet)}`);
 return out;
}

/** 0 read, no differences (whether or not the minimum is met yet) · 3 at least one compared call differed. */
export function shadowReportExitCode(evaluation:ShadowEvaluation):number{return evaluation.differencesAnywhere>0?3:0;}
