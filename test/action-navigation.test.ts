/** ADR 0181 decision 4: the navigation contract between a frame-keeping action and <ActionNavigateForm>. */
import {describe,expect,it} from 'vitest';
import {ACTION_NAVIGATION_FIELD,inAppHref,requestsClientNavigation,splitActionFeedback} from '../lib/action-navigation';

describe('action navigation',()=>{
 it('follows only in-app paths',()=>{
  for(const ok of ['/approvals','/approvals?category=leave&toast=Leave+approved','/','/?toast=Saved#top'])expect(inAppHref(ok)).toBe(ok);
  for(const bad of ['https://example.invalid/x','//example.invalid/x','/\\example.invalid','javascript:alert(1)','approvals','',' /approvals',
   '/a\nb','/a\\b','/'+'x'.repeat(2048),null,undefined,42,{navigate:'/'}])expect(inAppHref(bad)).toBeNull();
 });
 it('splits the toast feedback from the address, keeping every other parameter and the hash',()=>{
  const {href,feedback}=splitActionFeedback('/approvals?category=leave&toast=Leave+approved&sort=oldest&approvalSeal=1#row');
  expect(href).toBe('/approvals?category=leave&sort=oldest#row');
  expect(Object.fromEntries(feedback)).toEqual({toast:'Leave approved',approvalSeal:'1'});
  expect(splitActionFeedback('/?error=Not+allowed')).toEqual({href:'/',feedback:new URLSearchParams({error:'Not allowed'})});
  expect(splitActionFeedback('/approvals').href).toBe('/approvals');
 });
 it('recognises only the form mark',()=>{
  const form=new FormData();
  expect(requestsClientNavigation(form)).toBe(false);
  form.set(ACTION_NAVIGATION_FIELD,'server');expect(requestsClientNavigation(form)).toBe(false);
  form.set(ACTION_NAVIGATION_FIELD,'client');expect(requestsClientNavigation(form)).toBe(true);
  expect(requestsClientNavigation(null)).toBe(false);
 });
});
