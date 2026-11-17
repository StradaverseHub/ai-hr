/** Real native audiences: CaseView by itself never confers Personnel posting approval. */
import {beforeAll,afterAll,it,expect} from 'vitest';
import {migrateTestDb,closeAll} from './harness';
import {contractPostingFixture,releaseContractPosting} from './helpers/contract-posting-fixture';
import {contractSharedContext,readContractSharedPosting,listContractSharedPostings,approveContractSharedPosting} from '../packs/contracts/service';
beforeAll(migrateTestDb);afterAll(closeAll);
it('retains the native read-only case audience and the actual posting group as separate authorities',async()=>{
 const f=await contractPostingFixture(),posting=await releaseContractPosting(f);
 expect((await contractSharedContext(f.proposer,f.caseId)).flow).toBeTruthy();
 expect(await readContractSharedPosting(f.proposer,posting.id)).toMatchObject({id:posting.id,canApprove:false,canEdit:false});
 expect((await listContractSharedPostings(f.proposer,{status:'pending'})).rows).toEqual([]);
 await expect(approveContractSharedPosting(f.proposer,{id:posting.id,revision:posting.revision})).rejects.toMatchObject({code:'forbidden'});
 expect((await listContractSharedPostings(f.approver,{status:'pending'})).rows).toEqual([expect.objectContaining({id:posting.id,status:'pending',workflowReady:true,canApprove:true})]);
});
