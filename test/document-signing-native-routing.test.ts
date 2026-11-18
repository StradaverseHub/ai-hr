import {describe,expect,it} from 'vitest';
import {resolveNativeDocumentRouting} from '../lib/document-signing-native-routing';
import {documentRoutingSchema,nativeDocumentRoutingSchema} from '../lib/document-signing-routing-schema';
import type {Routing} from '../lib/onboarding-model';
const facts={businessGroup:'BU',company:'CO',department:'DP',title:'POS',grade:'JG17',employmentType:'full_time',joinDate:'2026-01-01',confirmationDate:'2026-07-01'};
const groups=[{id:'broad',name:'Broad',members:['one'],limit:0},{id:'specific',name:'Specific',members:['two'],limit:0},{id:'default',name:'Default',members:['three'],limit:0}];
describe('native document signing routing',()=>{
 it('preserves every native match dimension and list-order ties instead of applying Shared weighted matching',()=>{
  const routing:Routing={id:'native',name:'Native',rows:[{id:'one',rules:{businessGroup:['BU']},group:'broad'},{id:'two',rules:{grade:['JG17'],employmentType:['probation'],title:['POS']},group:'specific'},{id:'three',rules:{businessGroup:['BU'],company:['CO'],department:['DP']},group:'broad'}]};
  expect(resolveNativeDocumentRouting(routing,facts,groups,()=>true)).toEqual({userIds:['two'],groupId:'specific',reason:null});
  expect(resolveNativeDocumentRouting(routing,{...facts,grade:'JG18'},groups,()=>true).groupId).toBe('broad');
 });
 it('uses only the native empty-rule fallback when a matched group is unavailable',()=>{
  const routing:Routing={id:'native',name:'Native',rows:[{id:'one',rules:{grade:['JG17']},group:'specific'},{id:'default',rules:{},group:'default'}]};
  expect(resolveNativeDocumentRouting(routing,facts,groups,userId=>userId==='three')).toEqual({userIds:['three'],groupId:'default',reason:null});
  expect(resolveNativeDocumentRouting(routing,facts,groups,()=>false).reason).toContain('Nobody in the matching On/Off Boarding group');
  expect(resolveNativeDocumentRouting({...routing,rows:[]},facts,groups,()=>true).reason).toContain('No row');
 });
});

it('keeps Shared UUID identities strict and supports retained native string routing IDs explicitly',()=>{const value=[{id:'step',order:1,action:'sign',owner:false,who:{kind:'routing',routingId:'retained-native-id'}}];expect(documentRoutingSchema.safeParse(value).success).toBe(false);expect(nativeDocumentRoutingSchema.safeParse(value).success).toBe(true);});
