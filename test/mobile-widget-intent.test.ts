import {it,expect} from 'vitest';
import {clockWidgetAction,createWidgetIntentStore} from '../mobile/lib/widget-intent';
it('admits only the two public attendance hints and refuses credential, identity, command and URL injection',()=>{
 expect(clockWidgetAction('aihr://clock?action=in')).toBe('in');expect(clockWidgetAction('aihr://clock?action=out')).toBe('out');
 for(const u of ['https://clock?action=in','aihr://evil?action=in','aihr://user:password@clock?action=in','aihr://clock/path?action=in','aihr://clock?action=in&action=out','aihr://clock?action=in&employmentId=other','aihr://clock?action=in&requestId=forged','aihr://clock?action=in&lat=0','aihr://clock?action=in#credential','aihr://clock?action=approve','aihr://clock'])expect(clockWidgetAction(u)).toBeNull();
});
it('resumes a hint once after authentication, scopes it to the workplace/employment and expires it',()=>{
 const store=createWidgetIntentStore(),scope={namespace:'synthetic-workplace',employmentId:'own'};
 store.capture('aihr://clock?action=out',scope,1000);expect(store.take(scope,2000)).toBe('out');expect(store.take(scope,2001)).toBeNull();
 store.capture('aihr://clock?action=in',scope,1000);expect(store.take({...scope,employmentId:'other'},2000)).toBeNull();
 store.capture('aihr://clock?action=in',scope,1000);expect(store.take({...scope,namespace:'other'},2000)).toBeNull();
 store.capture('aihr://clock?action=in',scope,1000);expect(store.take(scope,301001)).toBeNull();
 store.capture('aihr://clock?action=in',scope,1000);expect(store.take(scope,999)).toBeNull();
 store.capture('aihr://clock?action=in',{...scope,employmentId:null},1000);expect(store.take(scope,2000)).toBe('in');
 store.capture('aihr://clock?action=in',scope,1000);store.clear();expect(store.take(scope,2000)).toBeNull();
});
