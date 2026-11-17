/** Hosted disposable proof: normal migrations, real restricted owner, frozen native oracle and read-only plans. */
import {expect,it} from 'vitest';
import {runRestrictedContractNavigationRuntime} from './helpers/contract-navigation-restricted-owner-runtime';
it('preserves every frozen5818 tracker right and bounds native navigation to company scope or the actual manager reports',async()=>{
 const receipt=await runRestrictedContractNavigationRuntime();
 expect(receipt).toMatchObject({version:1,sessionUser:'ai_hr_owner',currentUser:'ai_hr_owner',superuser:false,bypassRls:false,createRole:false,equivalentRights:true,readOnlyMeasurements:true,managedReports:1});
 expect(receipt.companies).toBeGreaterThanOrEqual(70);expect(receipt.employments).toBeGreaterThanOrEqual(1000);expect(receipt.actors).toBeGreaterThanOrEqual(12);
 expect(receipt.evidenceFiles).toEqual(['contract-navigation-owner-timings.json','contract-navigation-owner-plans.json']);
},1_200_000);
