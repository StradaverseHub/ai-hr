/**
 * ADR 0181 read-cost ratchets: the scanners and the shrink-only comparison behind test/read-cost-ratchets.test.ts and
 * test/read-cost-policy-authority.test.ts. The rules they enforce are in docs/architecture/FUTURE-BUILD-CONTRACT.md
 * ("Database read cost"), and the checked-in allowlists are in test/read-cost-ratchets/.
 *
 * Every ratchet works the same way as the pack drift guards (test/helpers/import-ratchet.ts): the scanner counts
 * today's uses of an old pattern, the allowlist records the count per file (or one entry per use), and
 *  - a count above its allowlisted number, or a key the allowlist does not have, fails: the old pattern grew;
 *  - a count below its allowlisted number, or an allowlist key that is no longer found, also fails until the allowlist
 *    is lowered to match: a conversion locks its win in, so the list only ever shrinks.
 * The failure prints the diff with file and line of each site, and for a shrink the exact replacement JSON.
 *
 * Detection is source-static and deliberately simple: comments are masked (and, for the loop scan, string contents
 * too) so prose does not count, but nothing is type-resolved. It is deterministic, so the allowlists seeded from the
 * same scanner are green on the commit that seeds them. A false positive is fixed by restructuring the code (for
 * example reading the set once before the loop), never by adding an allowlist entry.
 *
 * Pure and framework-free (node:fs and node:path only, no extension-less relative imports) so it also runs under
 * `node --experimental-strip-types` to regenerate a seed. test/ is never scanned.
 */
import {existsSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {join,sep} from 'node:path';

export type Counts=Record<string,number>;
/** One occurrence of a pattern: the allowlist key it counts towards, and where it is. */
export type Site={key:string;file:string;line:number;text:string};

// ---------------------------------------------------------------------------------------------------------------
// Files

const SOURCE=/\.(?:ts|tsx|mts|cts|js|jsx|mjs)$/;
const SKIP_DIRS=new Set(['node_modules','.next','.git','test','__tests__','migrations']);

/** Repo-relative POSIX paths of the source files under `dirs`, sorted. Missing directories are skipped. */
export function sourceFiles(rootDir:string,dirs:readonly string[]):string[]{
 const root=rootDir.replace(/[\\/]+$/,'');
 const out:string[]=[];
 const walk=(abs:string)=>{
  let st;
  try{st=statSync(abs);}catch{return;}
  if(st.isDirectory()){
   for(const name of readdirSync(abs)){if(!SKIP_DIRS.has(name))walk(join(abs,name));}
  }else if(SOURCE.test(abs)&&!/\.d\.ts$/.test(abs)){
   out.push(abs.slice(root.length+1).split(sep).join('/'));
  }
 };
 for(const dir of dirs)walk(join(root,dir));
 return out.sort();
}

export const read=(root:string,rel:string)=>readFileSync(join(root,rel),'utf8');

/** A module whose first statement is the 'use client' / 'use server' directive. */
export function directive(text:string):'client'|'server'|null{
 const m=/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use (client|server)['"]/.exec(text);
 return m?(m[1] as 'client'|'server'):null;
}

// ---------------------------------------------------------------------------------------------------------------
// Masking: comments (and optionally string contents) become spaces, keeping every index and newline in place.

function skipQuoted(text:string,start:number):number{
 const quote=text[start];
 for(let i=start+1;i<text.length;i++){
  const ch=text[i];
  if(ch==='\\'){i++;continue;}
  if(ch===quote)return i;
  // An unterminated quote (an apostrophe in JSX text, a regex literal) stops at the end of its line.
  if(ch==='\n')return i-1;
 }
 return text.length-1;
}

/** Same length as `text`; comments become spaces, and with `strings` the contents of string and template literals
 * do too (quotes and `${…}` expressions are kept). */
export function mask(text:string,opts:{strings:boolean}):string{
 const out=text.split('');
 const blank=(from:number,to:number)=>{for(let k=from;k<=to&&k<out.length;k++)if(out[k]!=='\n')out[k]=' ';};
 const code=(start:number,closeBrace:boolean):number=>{
  let depth=0;
  for(let i=start;i<text.length;i++){
   const ch=text[i],next=text[i+1];
   if(ch==='/'&&next==='/'){const end=text.indexOf('\n',i);const stop=end<0?text.length-1:end-1;blank(i,stop);i=stop;continue;}
   if(ch==='/'&&next==='*'){const end=text.indexOf('*/',i+2);const stop=end<0?text.length-1:end+1;blank(i,stop);i=stop;continue;}
   if(ch==="'"||ch==='"'){const end=skipQuoted(text,i);if(opts.strings)blank(i+1,end-1);i=end;continue;}
   if(ch==='`'){i=template(i);continue;}
   if(closeBrace){
    if(ch==='{')depth++;
    else if(ch==='}'){if(depth===0)return i;depth--;}
   }
  }
  return text.length-1;
 };
 const template=(start:number):number=>{
  let i=start+1,literalFrom=i;
  while(i<text.length){
   const ch=text[i];
   if(ch==='\\'){i+=2;continue;}
   if(ch==='`'){if(opts.strings)blank(literalFrom,i-1);return i;}
   if(ch==='$'&&text[i+1]==='{'){
    if(opts.strings)blank(literalFrom,i-1);
    const end=code(i+2,true);
    i=end+1;literalFrom=i;continue;
   }
   i++;
  }
  return text.length-1;
 };
 code(0,false);
 return out.join('');
}

/** Index of the bracket closing the one at `open` in masked text, or -1. */
export function closing(masked:string,open:number,limit=40_000):number{
 const o=masked[open],c=o==='('?')':o==='{'?'}':']';
 let depth=0;
 for(let i=open;i<masked.length&&i<open+limit;i++){
  const ch=masked[i];
  if(ch===o)depth++;
  else if(ch===c){depth--;if(depth===0)return i;}
 }
 return -1;
}

const lineAt=(text:string,index:number)=>{let n=1;for(let i=0;i<index;i++)if(text.charCodeAt(i)===10)n++;return n;};
const lineText=(text:string,index:number)=>{
 const from=text.lastIndexOf('\n',index-1)+1,to=text.indexOf('\n',index);
 return text.slice(from,to<0?undefined:to).trim().slice(0,160);
};

function sitesOf(file:string,raw:string,masked:string,re:RegExp,key:string):Site[]{
 const sites:Site[]=[];
 re.lastIndex=0;
 let m:RegExpExecArray|null;
 while((m=re.exec(masked))){sites.push({key,file,line:lineAt(raw,m.index),text:lineText(raw,m.index)});if(m[0].length===0)re.lastIndex++;}
 return sites;
}

// ---------------------------------------------------------------------------------------------------------------
// Ratchet: page-by-number lists and exact list totals (ADR 0181 decision 5).

/** The shared helpers are defined here; their own definitions are not uses. */
const PAGING_OWNER='lib/pagination.ts';
export const PAGING_PATTERNS:readonly {name:string;re:RegExp}[]=[
 // The numbered-page query (?page=N becomes an OFFSET). Lists use parseKeysetPageQuery.
 {name:'page-number query',re:/(?<![\w$.])parsePageQuery\s*\(/g},
 // A page state built from an exact total, which a numbered pager needs. Keyset lists use keysetPageState and
 // cappedTotal ("1,000+" with "Count exactly").
 {name:'exact-total page state',re:/(?<![\w$.])pageState\s*\(/g},
 // Every row read, then one page sliced in memory.
 {name:'in-memory page',re:/(?<![\w$.])paginateRows\s*\(/g},
 // OFFSET paging in Drizzle or in SQL text.
 {name:'OFFSET',re:/\.offset\s*\(|\boffset\s+(?:\$\{|\$\d|\d)/gi},
];
export const PAGING_DIRS=['app','components','core','lib','packs'] as const;

export function pagingSites(file:string,raw:string):Site[]{
 const masked=mask(raw,{strings:false});
 return PAGING_PATTERNS.flatMap(p=>sitesOf(file,raw,masked,new RegExp(p.re.source,p.re.flags),`${file} | ${p.name}`));
}
export function scanPaging(root:string):Site[]{
 return sourceFiles(root,PAGING_DIRS).filter(f=>f!==PAGING_OWNER).flatMap(file=>pagingSites(file,read(root,file)));
}

// ---------------------------------------------------------------------------------------------------------------
// Ratchet: layout-wide revalidatePath (ADR 0181 decision 4). A save that revalidates a layout redraws everything
// under it, frame included; saves return their result and navigate (lib/action-navigation.ts) instead.

export const REVALIDATE_DIRS=['app','components','core','lib','packs'] as const;
const LAYOUT_REVALIDATE=/\brevalidatePath\s*\((?:[^()]|\([^()]*\))*?,\s*['"`]layout['"`]\s*,?\s*\)/g;

export function layoutRevalidateSites(file:string,raw:string):Site[]{
 return sitesOf(file,raw,mask(raw,{strings:false}),new RegExp(LAYOUT_REVALIDATE.source,'g'),file);
}
export function scanLayoutRevalidate(root:string):Site[]{
 return sourceFiles(root,REVALIDATE_DIRS).flatMap(file=>layoutRevalidateSites(file,read(root,file)));
}

// ---------------------------------------------------------------------------------------------------------------
// Ratchet: per-company or per-row loops in a request (scale rule 2).

/** Request-path code: pages, layouts, route handlers, server actions and server components, plus the mobile API.
 * Client components ('use client') never reach the database and are skipped. core/ readers are also run by
 * workers, so they are covered by route budgets and scale tests rather than this static check. */
export function requestPathFiles(root:string):string[]{
 return [
  ...sourceFiles(root,['app','components']),
  ...sourceFiles(root,['core']).filter(f=>/^core\/mobile-[^/]+$/.test(f)),
  ...sourceFiles(root,['lib/mobile-api']),
 ].filter(f=>directive(read(root,f))!=='client');
}

/** A call that reads or writes the database: a session, context or transaction passed first, a `with…(`
 * transaction wrapper, a query on db/tx/client, or SQL text. (Spelt so this file's own text never names the
 * harness's tenant wrapper with its parenthesis, which would make scripts/gate-db-classify.ts call it DB.) */
const DATA_CALL=new RegExp([
 String.raw`(?<![\w$.])[A-Za-z_$][\w$]*\s*\(\s*(?:s|ctx|session|tx|trx)\s*[,)]`,
 String.raw`(?<![\w$.])with[A-Z][\w$]*\s*\(`,
 String.raw`\b(?:db|tx|trx|client|owner)\s*\.\s*(?:select|selectDistinct|execute|query|insert|update|delete|unsafe|transaction)\s*\(`,
 String.raw`\bsql\s*` + '`',
].join('|'));
const AWAIT=/\bawait\b/;
const LOOP=/\b(?:for\s*(?:await\s*)?\(|while\s*\(|do\s*\{)/g;
const CALLBACK=/\.\s*(?:map|flatMap|forEach|filter|reduce|some|every|find)\s*\(/g;
const FAN_OUT=/\bPromise\s*\.\s*(?:all|allSettled)\s*\(/g;

/** Loop sites in one request-path file (text in, so it is testable on fixtures). A site is a loop or array callback
 * that makes a data call for each element:
 *  (a) a for/while/do loop whose body awaits and makes a data call (a stream read loop makes none), or
 *  (b) an async array callback that makes a data call, or
 *  (c) an array callback inside Promise.all / allSettled that makes a data call (one call per element). */
export function requestLoopSites(file:string,raw:string):Site[]{
 const m=mask(raw,{strings:true});
 const sites:Site[]=[];
 const seen=new Set<number>();
 const add=(index:number)=>{if(seen.has(index))return;seen.add(index);sites.push({key:file,file,line:lineAt(raw,index),text:lineText(raw,index)});};
 let x:RegExpExecArray|null;
 LOOP.lastIndex=0;
 while((x=LOOP.exec(m))){
  let bodyFrom:number,bodyTo:number;
  if(x[0].startsWith('do')){bodyFrom=x.index+x[0].length-1;bodyTo=closing(m,bodyFrom);}
  else{
   const headerClose=closing(m,x.index+x[0].length-1);
   if(headerClose<0)continue;
   let i=headerClose+1;while(i<m.length&&/\s/.test(m[i]))i++;
   if(m[i]==='{'){bodyFrom=i;bodyTo=closing(m,i);}
   else{bodyFrom=i;const semi=m.indexOf(';',i);bodyTo=semi<0?m.length-1:semi;}
  }
  if(bodyTo<0)continue;
  const body=m.slice(bodyFrom,bodyTo+1);
  if(AWAIT.test(body)&&DATA_CALL.test(body))add(x.index);
 }
 const callbackSite=(open:number,inFanOut:boolean)=>{
  const close=closing(m,open);
  if(close<0)return;
  const body=m.slice(open+1,close);
  const isAsync=/^\s*async\b/.test(body);
  if((isAsync||inFanOut)&&DATA_CALL.test(body))add(open);
 };
 CALLBACK.lastIndex=0;
 while((x=CALLBACK.exec(m)))callbackSite(x.index+x[0].length-1,false);
 FAN_OUT.lastIndex=0;
 while((x=FAN_OUT.exec(m))){
  const open=x.index+x[0].length-1,close=closing(m,open);
  if(close<0)continue;
  const inner=m.slice(open,close);
  const cb=new RegExp(CALLBACK.source,'g');
  let y:RegExpExecArray|null;
  while((y=cb.exec(inner)))callbackSite(open+y.index+y[0].length-1,true);
 }
 return sites.sort((a,b)=>a.line-b.line);
}

export function scanRequestLoops(root:string):Site[]{
 return requestPathFiles(root).flatMap(file=>requestLoopSites(file,read(root,file)));
}

// ---------------------------------------------------------------------------------------------------------------
// Inventory: page routes and server actions, each of which must have a measured read budget (ADR 0181 decision 8).

export function pageRoutes(root:string):string[]{
 return sourceFiles(root,['app']).filter(f=>/(?:^|\/)page\.(?:tsx|ts|jsx|js)$/.test(f));
}

/** `file#name` for every exported function of every 'use server' module under app/. */
export function serverActions(root:string):string[]{
 const out:string[]=[];
 for(const file of sourceFiles(root,['app'])){
  const raw=read(root,file);
  if(directive(raw)!=='server')continue;
  const masked=mask(raw,{strings:false});
  const re=/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm;
  let m:RegExpExecArray|null;
  while((m=re.exec(masked)))out.push(`${file}#${m[1]}`);
 }
 return out.sort();
}

/** What a registered budget's measuring test must show: it measures statements and transactions with the shared
 * observer, and it renders the page module or calls the action by name. */
export function budgetEvidenceProblem(root:string,key:string,measuredBy:string):string|null{
 if(!existsSync(join(root,measuredBy)))return `${key}: measuring test ${measuredBy} does not exist`;
 const text=read(root,measuredBy);
 if(!/\bobserveStatements\b/.test(text))return `${key}: ${measuredBy} does not measure with observeStatements (test/helpers/statement-observer.ts)`;
 const [file,action]=key.split('#');
 if(action){
  if(!new RegExp(`\\b${action}\\b`).test(text))return `${key}: ${measuredBy} never names the action ${action}`;
 }else{
  const module=file.replace(/\.(?:tsx|ts|jsx|js)$/,'');
  if(!new RegExp(`${module.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}['"]`).test(text))return `${key}: ${measuredBy} never imports ${module}`;
 }
 return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Migrations that rewrite access-rule text (ADR 0181 Phase 2 lessons from releases 6 and 8).

/** SQL with `--` and block comments removed (string-unaware; comments only ever add false positives here). */
const sqlCode=(text:string)=>text.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/--[^\n]*/g,' ');
const POLICY_DDL=/\b(?:create|alter)\s+policy\b/i;
const FUNCTION_DDL=/\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"?([a-z_][\w$]*)"?\s*\.\s*)?"?([a-z_][\w$]*)"?/gi;

export function migrationFiles(root:string):string[]{
 const dir=join(root,'db','migrations');
 return existsSync(dir)?readdirSync(dir).filter(f=>f.endsWith('.sql')).sort():[];
}

/** Every `app.<name>(` called in the text of a CREATE or ALTER POLICY statement in any migration. */
export function policyStatementFunctions(root:string):Set<string>{
 const names=new Set<string>();
 for(const file of migrationFiles(root)){
  const code=sqlCode(readFileSync(join(root,'db','migrations',file),'utf8'));
  const re=/\b(?:create|alter)\s+policy\b/gi;
  let m:RegExpExecArray|null;
  while((m=re.exec(code))){
   const end=code.indexOf(';',m.index);
   const statement=code.slice(m.index,end<0?undefined:end);
   for(const call of statement.matchAll(/\bapp\s*\.\s*"?([a-z_][\w$]*)"?\s*\(/gi))names.add(call[1].toLowerCase());
  }
 }
 return names;
}

/** Migrations that change access-rule behaviour: policy DDL, or a (re)definition of a function policies call. */
export function policyRewriteMigrations(root:string,policyFunctions:ReadonlySet<string>):{file:string;reason:string}[]{
 const out:{file:string;reason:string}[]=[];
 for(const file of migrationFiles(root)){
  const code=sqlCode(readFileSync(join(root,'db','migrations',file),'utf8'));
  if(POLICY_DDL.test(code)){out.push({file,reason:'policy DDL'});continue;}
  const fns=[...code.matchAll(new RegExp(FUNCTION_DDL.source,'gi'))]
   .filter(m=>(!m[1]||m[1].toLowerCase()==='app')&&policyFunctions.has(m[2].toLowerCase())).map(m=>`app.${m[2].toLowerCase()}`);
  if(fns.length)out.push({file,reason:`redefines ${[...new Set(fns)].join(', ')}`});
 }
 return out;
}

/** What a policy-rewrite migration's timing test must show: the migration, a scale fixture and EXPLAIN ANALYZE. */
export function rewriteEvidenceProblem(root:string,migration:string,test:string):string|null{
 if(!existsSync(join(root,test)))return `${migration}: timing test ${test} does not exist`;
 const text=read(root,test),tag=migration.split('_')[0];
 if(!text.includes(tag))return `${migration}: ${test} never names migration ${tag}`;
 if(!/explain\s*\(\s*analy[sz]e|explain\s+analy[sz]e|\bexplainStatements\b/i.test(text))return `${migration}: ${test} has no EXPLAIN ANALYZE timing (or explainStatements)`;
 if(!/buildScaleFixture|scale-fixture|access-(?:effective-company|visible-employment)-fixture/.test(text))
  return `${migration}: ${test} uses no 70-company scale fixture (buildScaleFixture or an access pilot fixture)`;
 return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Policies: per-row authority calls (ADR 0181 decision 1). Pure parsing of pg_get_expr text; the database part is
// in test/read-cost-policy-authority.test.ts.

const SQL_WORDS=new Set(('and or not null true false is in case when then else end array select from where as any all some exists '+
 'distinct between like ilike similar to cast interval current_date current_timestamp current_time localtime localtimestamp '+
 'current_user session_user current_role current_catalog current_schema user with time zone without varying precision on join '+
 'left right inner outer full cross using group by order having limit offset union intersect except asc desc nulls first last '+
 'over partition filter within lateral values row of escape collate overlaps isnull notnull unknown symmetric').split(' '));

function sqlStringsBlanked(text:string){return text.replace(/'(?:[^']|'')*'/g,"''");}

/** Whether call arguments reference a column (any identifier that is not a function, type or keyword): then the
 * call is evaluated for every row, not once per statement. */
export function argumentsReferenceColumns(args:string):boolean{
 let t=sqlStringsBlanked(args);
 // An output alias (`( SELECT app.f() AS f)`) names no column of the row.
 t=t.replace(/\bas\s+"?[a-z_][\w$]*"?/gi,' ');
 t=t.replace(/::\s*"?[a-z_][\w$.]*"?(?:\s+(?:with|without)\s+time\s+zone|\s+varying|\s+precision)?(?:\s*\[\s*\])*/gi,' ');
 t=t.replace(/"?[a-z_][\w$]*"?(?:\s*\.\s*"?[a-z_][\w$]*"?)?\s*\(/gi,'(');
 for(const m of t.matchAll(/"?([a-z_][\w$]*)"?/gi)){
  const before=t[m.index!-1];
  if(before!==undefined&&/[\w$]/.test(before))continue; // part of a number such as 1e5
  if(!SQL_WORDS.has(m[1].toLowerCase()))return true;
 }
 return false;
}

/** Names (as printed) of authority functions called per row in one policy expression. */
export function perRowAuthorityCalls(expr:string|null,isAuthority:(schema:string|null,name:string)=>boolean):string[]{
 if(!expr)return [];
 const text=sqlStringsBlanked(expr);
 const found=new Set<string>();
 const re=/(?<![\w$."])(?:"?([a-z_][\w$]*)"?\.)?"?([a-z_][\w$]*)"?\(/gi;
 let m:RegExpExecArray|null;
 while((m=re.exec(text))){
  const schema=m[1]?m[1].toLowerCase():null,name=m[2].toLowerCase();
  if(!isAuthority(schema,name))continue;
  const open=m.index+m[0].length-1,close=closing(text,open);
  const args=close<0?text.slice(open+1):text.slice(open+1,close);
  if(argumentsReferenceColumns(args))found.add(schema?`${schema}.${name}`:name);
 }
 return [...found].sort();
}

// ---------------------------------------------------------------------------------------------------------------
// Comparison and reporting

export function countSites(sites:readonly Site[]):Counts{
 const counts:Counts={};
 for(const s of sites)counts[s.key]=(counts[s.key]??0)+1;
 return counts;
}
export const asCounts=(keys:readonly string[]):Counts=>countSites(keys.map(key=>({key,file:'',line:0,text:''})));

export type RatchetDiff={grown:{key:string;allowed:number;found:number}[];shrunk:{key:string;allowed:number;found:number}[]};

export function compareCounts(found:Counts,allowed:Counts):RatchetDiff{
 const keys=[...new Set([...Object.keys(found),...Object.keys(allowed)])].sort();
 const grown:RatchetDiff['grown']=[],shrunk:RatchetDiff['shrunk']=[];
 for(const key of keys){
  const f=found[key]??0,a=allowed[key]??0;
  if(f>a)grown.push({key,allowed:a,found:f});
  else if(f<a)shrunk.push({key,allowed:a,found:f});
 }
 return {grown,shrunk};
}

export function sortedCounts(counts:Counts):Counts{
 return Object.fromEntries(Object.entries(counts).filter(([,n])=>n>0).sort(([a],[b])=>a<b?-1:a>b?1:0));
}

/** The failure text for a ratchet: what grew (with every site) and the rule it breaks; or what shrank and the exact
 * allowlist to check in. Growth never prints a replacement allowlist: an entry is not the way to add a use. */
export function ratchetReport(o:{name:string;allowlist:string;rule:string;diff:RatchetDiff;sites?:readonly Site[];shrunkAllowlist?:string}):string{
 const lines:string[]=[];
 if(o.diff.grown.length){
  lines.push(`${o.name}: new uses of an old read-cost pattern. ${o.rule}`,`Allowlist ${o.allowlist} only shrinks; do not add to it.`);
  for(const g of o.diff.grown){
   lines.push(`  + ${g.key}: ${g.found} found, ${g.allowed} allowed`);
   for(const s of (o.sites??[]).filter(s=>s.key===g.key))lines.push(`      ${s.file}:${s.line}  ${s.text}`);
  }
 }
 if(o.diff.shrunk.length){
  lines.push(`${o.name}: fewer uses than ${o.allowlist} records. Lock the win in: replace the allowlist with the content below.`);
  for(const s of o.diff.shrunk)lines.push(`  - ${s.key}: ${s.found} found, ${s.allowed} allowed`);
  if(o.shrunkAllowlist)lines.push('--- replacement '+o.allowlist+' ---',o.shrunkAllowlist,'--- end ---');
 }
 return lines.join('\n');
}

/** A count allowlist shrunk to the found counts (never raised): what to check in after a conversion. */
export function shrunkCounts(found:Counts,allowed:Counts):Counts{
 const out:Counts={};
 for(const [key,a] of Object.entries(allowed))out[key]=Math.min(a,found[key]??0);
 return sortedCounts(out);
}
export const json=(value:unknown)=>JSON.stringify(value,null,1)+'\n';
