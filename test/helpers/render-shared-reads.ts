/** ADR 0181 queues addendum Q0: inside one page render the Contract work page and the Probation task list answer every
 * caller from one shared owner read. These checks ask the same questions outside a render (each reads the owner, as
 * before) and inside one modelled render (the shared read, then each derived answer), and require identical answers. */
import {expect} from 'vitest';
import type {SessionContext} from '../../db/client';
import {withRequestReadScope} from '../../lib/request-read-scope';
import {contractSharedWorkPage} from '../../core/contract-shared-tasks';
import {probationTaskList,type ProbationTaskList} from '../../core/probation';

type ContractQuery=Parameters<typeof contractSharedWorkPage>[1];
const CONTRACT_QUERIES:ContractQuery[]=[
 {category:'all',limit:20},{category:'tasks',limit:5,offset:0},{category:'approvals',limit:20},{category:'tasks',limit:1,offset:1},
 {category:'all',limit:1,offset:1},{category:'approvals',limit:1,offset:0},{category:'all',limit:100,offset:3},
];
export async function expectContractWorkSharedInRender(ctx:SessionContext,extra:ContractQuery[]=[]):Promise<void>{
 const queries=[...CONTRACT_QUERIES,...extra];
 const direct=[];for(const query of queries)direct.push(await contractSharedWorkPage(ctx,query));
 const rendered=await withRequestReadScope({},()=>Promise.all(queries.map(query=>contractSharedWorkPage(ctx,query))));
 expect(rendered).toEqual(direct);
}

type ProbationQuery=Parameters<typeof probationTaskList>[1];
// The owner orders by due date, case and part; one part can hold several tasks, whose order the owner leaves open.
const tieFree=(list:ProbationTaskList)=>({...list,items:[...list.items].sort((a,b)=>
 `${a.dueOn??''}|${a.caseId}|${a.partId}|${a.kind}`.localeCompare(`${b.dueOn??''}|${b.caseId}|${b.partId}|${b.kind}`))});
export async function expectProbationTasksSharedInRender(ctx:SessionContext,companyIds?:readonly string[]):Promise<void>{
 const queries:ProbationQuery[]=[{},{category:'approval'},{category:'task'},{limit:1},{category:'approval',limit:1},
  ...(companyIds?[{companyIds},{category:'approval',companyIds},{category:'task',companyIds}] as ProbationQuery[]:[])];
 const direct=[];for(const query of queries)direct.push(tieFree(await probationTaskList(ctx,query)));
 const rendered=(await withRequestReadScope({},()=>Promise.all(queries.map(query=>probationTaskList(ctx,query))))).map(tieFree);
 expect(rendered).toEqual(direct);
}
