/** Pure source/fixture-table controls only; no native execution, speed or admission claim. */
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {employeeChoiceBenchmarkContract,employeeChoiceBenchmarkCases,employeeChoiceBenchmarkNativeRows,employeeChoiceBenchmarkNativeCalls,type EmployeeChoiceBenchmarkPurpose} from './performance/employee-choice-benchmark-contract';
const first=Array.from({length:25},(_,i)=>'seed-'+(i+1)),last=Array.from({length:25},(_,i)=>'seed-'+(49976+i));
const sample=Array.from({length:500},(_,i)=>'seed-'+(i+1));
const facts={companyId:'company',foreignCompanyId:'foreign',departmentId:'department',representedBu:'represented',emptyBu:'empty',expectedFirst:first,expectedLast:last,organisationTagSample:sample};
const names=['initial','deep','search','department-active','department-and-unit','unit-active','organisation-deep','organisation-search','empty-unit','missing-search','broad-search','deep-broad-search','foreign-company'];
const extra=['complete-ids','held-access','held-history','full-server-population','full-server-ids','full-server-search-population','sparse-server-population'];
const phases=()=>employeeChoiceBenchmarkCases(facts).flatMap(value=>Array.from({length:value.repeat},()=>value.name)).concat(extra);

it('keeps only the two real existing purpose/file/report/SQL bindings and refuses unknown paired-purpose activation',()=>{
 expect(employeeChoiceBenchmarkContract('classic')).toEqual({file:'test/employee-choice-native-purpose-plan.test.ts',directory:'employee-choice-native-purpose',report:'employee-choice-native-purpose-plan.json',sql:'test/fixtures/employee-choice-native-purpose.sql',kind:'NATIVE_EMPLOYEE_CHOICE_PAGE_ASSIGNMENT_HYDRATION_V5',callPairs:27});
 expect(employeeChoiceBenchmarkContract('exact-ascii')).toEqual({file:'test/employee-choice-exact-ascii-plan.test.ts',directory:'employee-choice-exact-ascii',report:'employee-choice-exact-ascii-plan.json',sql:'test/fixtures/employee-choice-exact-ascii-purpose.sql',kind:'UNINSTALLED_NATIVE_EMPLOYEE_CHOICE_EXACT_ASCII_FILTER_V1',callPairs:22});
 for(const purpose of ['bounded','classic-vs-bounded','native','', '__proto__'])expect(()=>employeeChoiceBenchmarkContract(purpose as EmployeeChoiceBenchmarkPurpose)).toThrow('Unknown closed');
});
it('retains every original ordered port/repeat and derives18 timed ports and22 plan phases per variant',()=>{
 const cases=employeeChoiceBenchmarkCases(facts);expect(cases.map(row=>row.name)).toEqual(names);expect(cases.map(row=>row.repeat)).toEqual([2,1,1,2,1,1,1,1,1,1,1,1,1]);
 expect(new Set([...names,'complete-ids','held-access','held-history','full-server-population','full-server-search-population']).size).toBe(18);expect(phases()).toHaveLength(22);expect(phases().filter(name=>name==='initial')).toHaveLength(2);expect(phases().filter(name=>name==='department-active')).toHaveLength(2);
});
it('derives first/deep/selection/foreign and exact filter inputs from independent seed facts',()=>{
 const rows=employeeChoiceBenchmarkCases(facts),byName=Object.fromEntries(rows.map(row=>[row.name,row]));
 expect(byName.initial).toEqual({name:'initial',input:{companyIds:['company'],selectedId:last.at(-1)},total:50000,ids:first,repeat:2,selected:last.at(-1)});
 expect(byName.deep.input.offset).toBe(49975);expect(byName.deep.ids).toEqual(last);expect(byName.search.input.query).toBe('PERF000050000');expect(byName.search.ids).toEqual([last.at(-1)]);
 expect(byName['foreign-company']).toEqual({name:'foreign-company',input:{companyIds:['foreign'],selectedId:last.at(-1)},total:0,ids:[],repeat:1,selected:null});
 expect(byName['empty-unit'].input.businessUnitId).toBe('empty');expect(byName['missing-search'].total).toBe(0);expect(byName['deep-broad-search'].input).toMatchObject({query:'fictional retained',offset:49975});
});
it('retains independently counted400 active organization members and both complete bounded page expectations',()=>{
 const rows=employeeChoiceBenchmarkCases(facts),byName=Object.fromEntries(rows.map(row=>[row.name,row])),active=sample.filter((_,i)=>(i+1)%5!==0);
 expect(active).toHaveLength(400);expect(byName['department-active'].total).toBe(40000);expect(byName['department-active'].ids).toEqual(active.slice(0,25));
 expect(byName['department-and-unit'].input).toMatchObject({departmentId:'department',businessUnitId:'represented',status:'active'});expect(byName['department-and-unit'].total).toBe(400);
 expect(byName['organisation-deep'].input.offset).toBe(375);expect(byName['organisation-deep'].ids).toEqual(active.slice(375));expect(byName['organisation-search'].ids).toEqual([sample[0]]);
});
it('requires27 classic or22 exact-ASCII real native call pairs across the complete original22-phase matrix',()=>{
 for(const purpose of ['classic','exact-ascii']as const){const actual=phases().flatMap(name=>employeeChoiceBenchmarkNativeCalls(purpose,name));expect(actual).toHaveLength(purpose==='classic'?27:22);expect(actual.filter(call=>call.port==='project')).toHaveLength(purpose==='classic'?5:0);}
 for(const purpose of ['classic','exact-ascii']as const)expect(()=>employeeChoiceBenchmarkNativeCalls(purpose,'omitted-or-invented')).toThrow('Missing independent');
});
it('keeps exact classic full-membership/nearer-end25 and2000 hydration proofs distinct from one-call exact ASCII',()=>{
 expect(employeeChoiceBenchmarkNativeCalls('classic','deep-broad-search')).toEqual([{port:'page',rows:50005},{port:'project',rows:26,matchedIds:50000,assignmentPageRows:25,pagination:{total:50000,offset:49975,limit:25}}]);
 expect(employeeChoiceBenchmarkNativeCalls('classic','full-server-search-population')).toEqual([{port:'page',rows:50005,serverScopeIds:50000},{port:'project',rows:2001,matchedIds:50000,serverScopeIds:50000,assignmentPageRows:2000,pagination:{total:50000,offset:48000,limit:2000}}]);
 expect(employeeChoiceBenchmarkNativeCalls('exact-ascii','full-server-search-population')).toEqual([{port:'page',rows:2005,serverScopeIds:50000,pagination:{total:50000,offset:48000,limit:2000}}]);
 expect(employeeChoiceBenchmarkNativeCalls('exact-ascii','deep-broad-search')).toEqual([{port:'page',rows:30,pagination:{total:50000,offset:49975,limit:25}}]);
 expect(employeeChoiceBenchmarkNativeRows('classic','organisation-search')).toBe(505);expect(employeeChoiceBenchmarkNativeRows('exact-ascii','organisation-search')).toBe(6);
});
it('retains complete/sparse/foreign/held native outputs and full50000 server IDs without a page ceiling',()=>{
 for(const purpose of ['classic','exact-ascii']as const){
  expect(employeeChoiceBenchmarkNativeCalls(purpose,'complete-ids')).toEqual([{port:'ids',rows:400}]);expect(employeeChoiceBenchmarkNativeCalls(purpose,'full-server-ids')).toEqual([{port:'ids',rows:50000,serverScopeIds:50000}]);
  expect(employeeChoiceBenchmarkNativeCalls(purpose,'sparse-server-population')).toEqual([{port:'page',rows:7}]);expect(employeeChoiceBenchmarkNativeCalls(purpose,'foreign-company')).toEqual([{port:'page',rows:1}]);expect(employeeChoiceBenchmarkNativeCalls(purpose,'held-access')).toEqual([{port:'page',rows:30}]);expect(employeeChoiceBenchmarkNativeCalls(purpose,'held-history')).toEqual([{port:'page',rows:30}]);
 }
});
it('keeps the real five-file lifecycle profile/caps and fixed old entry registrations unchanged in meaning',()=>{
 const profile=JSON.parse(readFileSync('.github/ci/employee-lifecycle-profile.json','utf8'));expect(profile.files).toHaveLength(5);
 for(const purpose of ['classic','exact-ascii']as const){
  const contract=employeeChoiceBenchmarkContract(purpose),row=profile.files.find((value:{file:string})=>value.file===contract.file);expect(row).toMatchObject({cases:6,stageSeconds:960,fileSeconds:900,workSeconds:840,cleanupSeconds:60,planPhases:44,callPairs:contract.callPairs});
  expect(readFileSync(contract.file,'utf8')).toBe(`/** Fixed existing native benchmark entry. The shared owner admits its exact\n * real lifecycle profile before any hooks, constructors or SQL. */\nimport {registerEmployeeChoiceBenchmark} from './performance/employee-choice-benchmark-harness';\nregisterEmployeeChoiceBenchmark('${purpose}');\n`);
 }
 const harness=readFileSync('test/performance/employee-choice-benchmark-harness.ts','utf8');expect(harness).toContain('const lifecycle=admitEmployeeChoiceLifecycle(file);');expect(harness).toContain('assertPage(page,c)');expect(harness).toContain('expect(stable(page)).toEqual(pages.get(c.name))');expect(harness).toContain('expect(phases).toBe(44);expect(callPairs).toBe(contract.callPairs)');expect(harness).toContain("expect(report.performanceTargetPassed,ascii?'All18 native whole ports, including actual cold qualification, must meet the unchanged1000ms target':'All18 native whole ports must meet the unchanged1000ms target').toBe(true)");
});
