/** Hosted-only positive runtime proof; no role simulation or alternate migration application. */
import {expect,it} from 'vitest';
import {runRestrictedContractPostingRuntime} from './helpers/contract-posting-restricted-owner-runtime';
it('applies a protected past Contract renewal through the literal restricted ai_hr_owner queue connection',async()=>{
 const receipt=await runRestrictedContractPostingRuntime();
 expect(receipt).toMatchObject({version:1,sessionUser:'ai_hr_owner',currentUser:'ai_hr_owner',superuser:false,bypassRls:false,
  postingStatus:'approved',applicationState:'applied',queueBackendMatchesReceipt:true});
 expect(receipt.preservedPayslips).toBeGreaterThanOrEqual(2);
},1_200_000);
