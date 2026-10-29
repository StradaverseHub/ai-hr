import {describe,expect,it} from 'vitest';
import {OfflineClockReceipt,OfflineClockDecision,OfflineClockServiceRefusal} from '../lib/mobile-offline-receipt';
import {offlineClockReportedBounds} from '../lib/mobile-api/offline-clock-time';
const id='00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa',issuedAt=1793055753390;
const claim=(minimumNs:string,maximumNs:string)=>({time:{claimedAt:issuedAt,elapsed:{status:'elapsed' as const,minimumNs,maximumNs,continuity:'same_process' as const}}});
const receipt={version:1,purpose:'attendance.clock.offline.receipt',id,contextId:id,requestId:id,sequence:1,digest:'a'.repeat(64),outcome:'needs_review',reason:'review_required',receivedAt:issuedAt+100,effectiveMinimum:issuedAt,effectiveMaximum:issuedAt+50,effectiveAt:null,captureId:null,photo:null};
describe('versioned offline receipts and unverified duration bounds',()=>{
 it('rounds duration endpoints outward and intersects the upper report with actual server admission',()=>{
  expect(offlineClockReportedBounds({issuedAt},claim('1000001','2999999'),issuedAt+100)).toEqual({status:'reported_interval',minimum:issuedAt+1,maximum:issuedAt+3});
  expect(offlineClockReportedBounds({issuedAt},claim('0','1000000000'),issuedAt+7)).toEqual({status:'reported_interval',minimum:issuedAt,maximum:issuedAt+7});
 });
 it('does not reconstruct unknown continuity or accept wholly future reports and timestamp overflow',()=>{
  expect(offlineClockReportedBounds({issuedAt},{time:{claimedAt:issuedAt,elapsed:{status:'unknown',reason:'boot_changed'}}},issuedAt+1)).toEqual({status:'unavailable',reason:'continuity_unknown'});
  expect(offlineClockReportedBounds({issuedAt},claim('10000000','20000000'),issuedAt+1)).toEqual({status:'unavailable',reason:'future_interval'});
  expect(offlineClockReportedBounds({issuedAt:8640000000000000},claim('1','1000000'),8640000000000000)).toEqual({status:'unavailable',reason:'invalid_interval'});
 });
 it('separates review/refusal receipts from accepted captures and forbids caller authority fields',()=>{
  expect(OfflineClockReceipt.parse(receipt).outcome).toBe('needs_review');
  expect(OfflineClockReceipt.safeParse({...receipt,outcome:'accepted',reason:'clock_accepted',captureId:id,effectiveAt:issuedAt+25}).success).toBe(true);
  for(const change of [{accepted:true},{verified:true},{outcome:'accepted'},{captureId:id},{effectiveAt:issuedAt},{effectiveMaximum:issuedAt-1},{outcome:'accepted',reason:'clock_accepted',captureId:id,effectiveAt:issuedAt+51}])expect(OfflineClockReceipt.safeParse({...receipt,...change}).success).toBe(false);
 });
 it('admits only named dispositions and an actual capture/effective instant for acceptance',()=>{
  expect(OfflineClockDecision.safeParse({outcome:'needs_review',reason:'continuity_unknown'}).success).toBe(true);
  for(const value of [{outcome:'accepted',reason:'clock_accepted'},{outcome:'refused',reason:'clock_accepted'},{outcome:'needs_review',reason:'AI_says_yes'},{outcome:'accepted',reason:'clock_accepted',captureId:id,effectiveAt:issuedAt,verified:true}])expect(OfflineClockDecision.safeParse(value).success).toBe(false);
 });
 it('keeps the request-collision refusal service-owned, terminal and without an attendance instant',()=>{
  const conflict={...receipt,outcome:'refused',reason:'request_conflict'};
  expect(OfflineClockReceipt.parse(conflict).reason).toBe('request_conflict');expect(OfflineClockServiceRefusal.parse({outcome:'refused',reason:'request_conflict'}).reason).toBe('request_conflict');
  for(const change of [{outcome:'needs_review'},{outcome:'accepted'},{captureId:id},{effectiveAt:issuedAt+25},{outcome:'accepted',captureId:id,effectiveAt:issuedAt+25}])expect(OfflineClockReceipt.safeParse({...conflict,...change}).success).toBe(false);
  for(const outcome of ['refused','needs_review'])expect(OfflineClockDecision.safeParse({outcome,reason:'request_conflict'}).success).toBe(false);
  expect(OfflineClockServiceRefusal.safeParse({outcome:'needs_review',reason:'request_conflict'}).success).toBe(false);
 });
});
