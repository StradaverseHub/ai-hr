/** Hosted disposable proof: normal migrations, real restricted owner, frozen native oracle and read-only plans. */
import {expect,it} from 'vitest';
import {runRestrictedContractNavigationRuntime} from './helpers/contract-navigation-restricted-owner-runtime';
it('preserves every frozen5818 tracker right and bounds native navigation to company scope or the actual manager reports',async()=>{
 const receipt=await runRestrictedContractNavigationRuntime();
 expect(receipt).toMatchObject({version:1,sessionUser:'ai_hr_owner',currentUser:'ai_hr_owner',superuser:false,bypassRls:false,createRole:false,equivalentRights:true,readOnlyMeasurements:true,managedReports:1});
 expect(receipt.companies).toBeGreaterThanOrEqual(70);expect(receipt.employments).toBeGreaterThanOrEqual(1000);expect(receipt.actors).toBeGreaterThanOrEqual(12);
 expect(Object.keys(receipt.backends)).toHaveLength(receipt.actors);
 expect(new Set(Object.values(receipt.backends).map(backend=>backend.pid)).size).toBe(receipt.actors);
 expect(new Set(Object.values(receipt.backends).map(backend=>backend.applicationName)).size).toBe(receipt.actors);
 for(const [actor,backend] of Object.entries(receipt.backends)){
  expect(backend).toMatchObject({sessionUser:'ai_hr_app',currentUser:'ai_hr_app'});
  expect(backend.applicationName).toMatch(/^contract-nav:[a-f0-9]{8}:/);expect(backend.applicationName.endsWith(':'+actor)).toBe(true);
 }
 expect(receipt.evidenceFiles).toEqual(['contract-navigation-owner-timings.json','contract-navigation-owner-plans.json']);
},1_200_000);
