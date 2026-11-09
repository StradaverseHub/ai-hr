/** Source-owned benchmark data, not host admission, runtime qualification or authority. */
import type {EmployeeChoiceInput} from '../../lib/employee-choice';
import type {NativeCallExpectation} from './employee-choice-auto-explain-parser';
export type EmployeeChoiceBenchmarkPurpose='classic'|'exact-ascii';
const contracts=Object.freeze({
 classic:Object.freeze({file:'test/employee-choice-native-purpose-plan.test.ts',directory:'employee-choice-native-purpose',report:'employee-choice-native-purpose-plan.json',sql:'test/fixtures/employee-choice-native-purpose.sql',kind:'NATIVE_EMPLOYEE_CHOICE_PAGE_ASSIGNMENT_HYDRATION_V5',callPairs:27}),
 'exact-ascii':Object.freeze({file:'test/employee-choice-exact-ascii-plan.test.ts',directory:'employee-choice-exact-ascii',report:'employee-choice-exact-ascii-plan.json',sql:'test/fixtures/employee-choice-exact-ascii-purpose.sql',kind:'UNINSTALLED_NATIVE_EMPLOYEE_CHOICE_EXACT_ASCII_FILTER_V1',callPairs:22}),
});
export function employeeChoiceBenchmarkContract(purpose:EmployeeChoiceBenchmarkPurpose){
 if(!Object.hasOwn(contracts,purpose))throw Error('Unknown closed employee benchmark purpose');return contracts[purpose];
}
export type EmployeeChoiceBenchmarkCase={name:string;input:EmployeeChoiceInput&{companyIds:string[]};total:number;ids:string[];repeat:number;selected:string|null};
type Fixture={departmentId:string;companyId:string;foreignCompanyId:string;representedBu:string;emptyBu:string;expectedFirst:string[];expectedLast:string[];organisationTagSample:string[]};
/** Expectations derive from independent seed identities/counts, never a reader's returned DTO. */
export function employeeChoiceBenchmarkCases(f:Fixture):EmployeeChoiceBenchmarkCase[]{
 const {expectedFirst,expectedLast,organisationTagSample}=f,last=expectedLast.at(-1)!,scope={companyIds:[f.companyId],selectedId:last};
 const activeIds=organisationTagSample.filter((_,index)=>(index+1)%5!==0),representedBu=f.representedBu,emptyBu=f.emptyBu;
 return [
  {name:'initial',input:scope,total:50000,ids:expectedFirst,repeat:2,selected:last},
  {name:'deep',input:{...scope,offset:49975},total:50000,ids:expectedLast,repeat:1,selected:last},
  {name:'search',input:{...scope,query:'PERF000050000'},total:1,ids:[last],repeat:1,selected:last},
  {name:'department-active',input:{...scope,departmentId:f.departmentId,status:'active'},total:40000,ids:activeIds.slice(0,25),repeat:2,selected:last},
  {name:'department-and-unit',input:{...scope,departmentId:f.departmentId,businessUnitId:representedBu,status:'active'},total:400,ids:activeIds.slice(0,25),repeat:1,selected:last},
  {name:'unit-active',input:{...scope,businessUnitId:representedBu,status:'active'},total:400,ids:activeIds.slice(0,25),repeat:1,selected:last},
  {name:'organisation-deep',input:{...scope,departmentId:f.departmentId,businessUnitId:representedBu,status:'active',offset:375},total:400,ids:activeIds.slice(375),repeat:1,selected:last},
  {name:'organisation-search',input:{...scope,departmentId:f.departmentId,businessUnitId:representedBu,query:'PERF000000001'},total:1,ids:[organisationTagSample[0]],repeat:1,selected:last},
  {name:'empty-unit',input:{...scope,departmentId:f.departmentId,businessUnitId:emptyBu},total:0,ids:[],repeat:1,selected:last},
  {name:'missing-search',input:{...scope,query:'no fictional organisation employee matches'},total:0,ids:[],repeat:1,selected:last},
  {name:'broad-search',input:{...scope,query:'fictional retained'},total:50000,ids:expectedFirst,repeat:1,selected:last},
  {name:'deep-broad-search',input:{...scope,query:'fictional retained',offset:49975},total:50000,ids:expectedLast,repeat:1,selected:last},
  {name:'foreign-company',input:{companyIds:[f.foreignCompanyId],selectedId:last},total:0,ids:[],repeat:1,selected:null},
 ];
}
/** Every retained name is non-ASCII. Classic streams conservative identities;
 * exact ASCII filters/counts/pages in SQL under its separately qualified runtime. */
export function employeeChoiceBenchmarkNativeRows(purpose:EmployeeChoiceBenchmarkPurpose,name:string){
 employeeChoiceBenchmarkContract(purpose);
 const candidates:Record<string,number>={initial:25,deep:25,search:purpose==='classic'?50000:1,'department-active':25,'department-and-unit':25,
  'unit-active':25,'organisation-deep':25,'organisation-search':purpose==='classic'?500:1,'empty-unit':0,'missing-search':purpose==='classic'?50000:0,'broad-search':purpose==='classic'?50000:25,'deep-broad-search':purpose==='classic'?50000:25};
 if(name==='foreign-company')return 1;
 if(name==='complete-ids')return 400;
 if(name==='full-server-population')return 2005;
 if(name==='full-server-search-population')return purpose==='classic'?50005:2005;
 if(name==='full-server-ids')return 50000;
 if(name==='sparse-server-population')return 7;
 if(name==='held-access'||name==='held-history')return 30;
 if(!Object.hasOwn(candidates,name))throw Error('Missing independent native stream fixture');return 5+candidates[name];
}
export function employeeChoiceBenchmarkNativeCalls(purpose:EmployeeChoiceBenchmarkPurpose,name:string):NativeCallExpectation[]{
 const first:NativeCallExpectation={port:name==='complete-ids'||name==='full-server-ids'?'ids':'page',rows:employeeChoiceBenchmarkNativeRows(purpose,name)};
 if(name==='initial'||name==='deep')first.pagination={total:50000,offset:name==='deep'?49975:0,limit:25};
 if(name==='full-server-population')return[{...first,serverScopeIds:50000,pagination:{total:50000,offset:48000,limit:2000}}];
 if(name==='full-server-search-population')return purpose==='classic'
  ?[{...first,serverScopeIds:50000},{port:'project',rows:2001,matchedIds:50000,serverScopeIds:50000,assignmentPageRows:2000,pagination:{total:50000,offset:48000,limit:2000}}]
  :[{...first,serverScopeIds:50000,pagination:{total:50000,offset:48000,limit:2000}}];
 if(name==='full-server-ids')return[{...first,serverScopeIds:50000}];
 if(purpose==='classic'&&name==='search')return[first,{port:'project',rows:2,matchedIds:1,assignmentPageRows:1}];
 if(purpose==='classic'&&name==='organisation-search')return[first,{port:'project',rows:2,matchedIds:1}];
 if(name==='broad-search'||name==='deep-broad-search')return purpose==='classic'
  ?[first,{port:'project',rows:26,matchedIds:50000,assignmentPageRows:25,pagination:{total:50000,offset:name==='deep-broad-search'?49975:0,limit:25}}]
  :[{...first,pagination:{total:50000,offset:name==='deep-broad-search'?49975:0,limit:25}}];
 return[first];
}
