/** Audit only: compare the actual preloaded profile matcher and actual remote reader under the same scope. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {listWorkforcePickOptions,searchWorkforceEmployees} from '../../core/read';
import {foldEmployeeCode,matchEmployees} from '../../lib/employee-search';
import * as schema from '../../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';

const file='test/performance/personnel-switcher-ranking-audit.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);
afterAll(closeAll);

it.skipIf(!requested)('reports profile JS and remote native ranking parity and differences on real authorized data',async()=>{
 const report:Record<string,unknown>={kind:'PERSONNEL_SWITCHER_SEMANTICS_AUDIT_ONLY',releaseEligible:false};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-switcher-ranking-audit.json'),JSON.stringify(report,null,2));
 try{
  await resetDb();const b=await seedBase(),foreign=await seedBase(),actor=adminCtx(b);
  const definitions=[
   ['dotted-i','İnce Example','TR001'],
   ['sigma-final','ΟΣ','GR001'],
   ['sigma-middle','ΟΣΑ','GR002'],
   ['german','Straße Name','DE001'],
   ['composed','Renée Name','FR001'],
   ['decomposed','Rene\u0301e Name','FR002'],
   ['nbsp','Code Space NBSP','EMP\u00a0123'],
   ['em-space','Code Space EM','EMP\u2003124'],
   ['bom','Code Space BOM','EMP\ufeff125'],
   ['ascii-spaces','Code ASCII Separator','A B.C_D-1'],
   ['rank-fold-a','A Exact Fold','EMP-0008'],
   ['rank-fold-b','B Exact Fold','EMP0008'],
   ['rank-prefix','C Prefix Fold','EMP00080'],
   ['rank-name','Emp0008 begins name','RANK001'],
   ['rank-code-contains','Code contains folded','EEMP0008X'],
   ['rank-name-contains','Name with emp0008 token','RANK002'],
   ['wildcard','Percent %_ marker','BACK\\SLASH'],
   ['long-name','x'.repeat(201)+' Long','LONG001'],
   ...Array.from({length:11},(_,i)=>['cap-'+i,'Repeated tie',null] as const),
  ] as const;
  const people=definitions.map(([tag,name,employeeCode])=>({tag,name,employeeCode,personId:randomUUID(),employmentId:randomUUID()}));
  await owner.db.insert(schema.person).values(people.map(p=>({id:p.personId,tenantId:b.tenantId,fullName:p.name,primaryEmail:p.personId+'@example.invalid'})));
  await owner.db.insert(schema.employment).values(people.map(p=>({id:p.employmentId,tenantId:b.tenantId,personId:p.personId,companyId:b.companyId,
   employeeCode:p.employeeCode,hiredOn:'2020-01-01',terminatedOn:p.tag==='rank-fold-b'?'2025-01-01':null})));
  const [outside]=await owner.db.insert(schema.person).values({tenantId:foreign.tenantId,fullName:'Foreign Unicode İnce',primaryEmail:'foreign@example.invalid'}).returning();
  await owner.db.insert(schema.employment).values({tenantId:foreign.tenantId,personId:outside.id,companyId:foreign.companyId,employeeCode:'FOREIGN1',hiredOn:'2020-01-01'});
  const old=await listWorkforcePickOptions(actor,[b.companyId,foreign.companyId]);
  expect(old).toHaveLength(people.length);
  const tags=new Map(people.map(p=>[p.employmentId,p.tag]));
  const selectedTags=(rows:typeof old)=>rows.map(row=>tags.get(row.employmentId)??'OUTSIDE');
  const queries=[
   ['turkish-ascii','in'],['turkish-original','İn'],['turkish-combining','i\u0307n'],['greek-final','ος'],['greek-nonfinal','οσ'],
   ['german-same','STRaßE'],['german-not-full-fold','STRASSE'],['composed','Renée'],['decomposed','Rene\u0301e'],
   ['nbsp-code','EMP123'],['em-space-code','EMP124'],['bom-code','EMP125'],['ascii-spaces','abcd1'],
   ['fold-ranks','emp0008'],['fold-prefixes','  emp-000  '],['name-id-tie-cap','Repeated tie'],['literal-percent-underscore','%_'],
   ['literal-backslash','\\sLaSh'],['blank','  '],['foreign','FOREIGN1'],['none','not-an-employee'],
  ] as const;
  const comparisons=[];
  for(const [label,q] of queries){
   const local=selectedTags(matchEmployees(old,q)),remote=selectedTags(await searchWorkforceEmployees(actor,[b.companyId,foreign.companyId],q));
   comparisons.push({label,q,local,remote,exact:JSON.stringify(local)===JSON.stringify(remote)});
  }
  const capped='x'.repeat(201);
  const localLong=selectedTags(matchEmployees(old,capped));
  await expect(searchWorkforceEmployees(actor,[b.companyId],capped)).rejects.toThrow('Invalid employee search');
  expect(localLong).toEqual(['long-name']);
  report.queryLength={length:capped.length,local:localLong,remote:'rejected'};report.comparisons=comparisons;
  report.database=(await owner.client`select current_setting('lc_collate') as lc_collate,current_setting('lc_ctype') as lc_ctype,
   current_setting('server_encoding') as encoding,version() as version`)[0];
  report.javascript={icu:process.versions.icu,unicode:process.versions.unicode};
  const [icu]=await owner.client`select to_regcollation('pg_catalog."und-x-icu"') is not null as available`;
  const mapping=[];
  const jsWhitespace='\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff._-';
  for(const input of ['İnce','ΟΣ','ΟΣΑ','Straße','Renée','Rene\u0301e','EMP\u00a0123','EMP\u2003124','EMP\ufeff125','A B.C_D-1']){
   const [plain]=await owner.client`select lower(${input}::text) as lower,regexp_replace(lower(${input}::text),'[[:space:]._-]','','g') as folded`;
   const [candidate]=icu.available?await owner.client`select lower(${input}::text collate pg_catalog."und-x-icu") as lower,
    translate(lower(${input}::text collate pg_catalog."und-x-icu"),${jsWhitespace},'') as folded`:[];
   mapping.push({input,jsLower:input.toLowerCase(),jsFolded:foldEmployeeCode(input),postgres:plain,optionalIcuExplicitWhitespace:candidate});
  }
  report.icuAvailable=icu.available;report.mapping=mapping;save();
  for(const label of ['german-same','german-not-full-fold','composed','decomposed','ascii-spaces','fold-ranks','fold-prefixes',
   'name-id-tie-cap','literal-percent-underscore','literal-backslash','blank','foreign','none'])expect(comparisons.find(c=>c.label===label)?.exact,label).toBe(true);
  expect(comparisons.find(c=>c.label==='fold-ranks')?.local).toEqual(['rank-fold-a','rank-fold-b','rank-prefix','rank-name','rank-code-contains','rank-name-contains']);
  expect(comparisons.find(c=>c.label==='name-id-tie-cap')?.local).toHaveLength(8);
  expect(comparisons.some(c=>!c.exact),'the current local and native matchers are not interchangeable').toBe(true);
 }finally{save();}
},120000);
