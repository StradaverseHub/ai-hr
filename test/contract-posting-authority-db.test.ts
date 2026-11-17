/** Real native audiences: CaseView by itself never confers Personnel posting approval. */
import {beforeAll,afterAll,it,expect} from 'vitest';
import {migrateTestDb,closeAll} from './harness';
import {contractPostingFixture,releaseContractPosting} from './helpers/contract-posting-fixture';
import {contractSharedContext,readContractSharedPosting,readContractSharedPostingSummary,listContractSharedPostings,approveContractSharedPosting} from '../packs/contracts/service';
beforeAll(migrateTestDb);afterAll(closeAll);
it('retains the native read-only case audience and the actual posting group as separate authorities',async()=>{
 const f=await contractPostingFixture(),posting=await releaseContractPosting(f);
 expect((await contractSharedContext(f.proposer,f.caseId)).flow).toBeTruthy();
 // Case View exposes its own shaped receipt; the native Personnel editor/terms require the
 // posting approver group even when the caller may read and decide this Contract case.
 expect(await readContractSharedPosting(f.proposer,posting.id)).toBeNull();
 const summary=await readContractSharedPostingSummary(f.proposer,f.caseId);
 expect(summary).toMatchObject({postingId:posting.id,label:posting.label,status:'pending',canConfirmPay:false});
 for(const field of ['proposed','edited','current','canApprove','canEdit'])expect(summary).not.toHaveProperty(field);
 expect((await listContractSharedPostings(f.proposer,{status:'pending'})).rows).toEqual([]);
 await expect(approveContractSharedPosting(f.proposer,{id:posting.id,revision:posting.revision})).rejects.toMatchObject({code:'forbidden'});
 expect((await listContractSharedPostings(f.approver,{status:'pending'})).rows).toEqual([expect.objectContaining({id:posting.id,status:'pending',workflowReady:true,canApprove:true})]);
});
