import {describe,it,expect} from 'vitest';
import {defaultEmailConfig} from '../lib/identity/email-model';
import {emailConnections,publicEmailConnections,saveEmailConnection,testedEmailConnection,activateEmailConnection,type ConnectionState} from '../lib/internal-auth/email-connections';
const config={...defaultEmailConfig,host:'smtp.example.test',port:587,security:'starttls' as const,from:'hr@example.test',user:'hr@example.test',fromName:'OneHR'};
const state=():ConnectionState=>({revision:'initial',active:{config,password:'fictional-old-secret'}});
describe('named SMTP connections',()=>{
 it('adopts the current relay without changing its credentials, and never exposes secrets in the list',()=>{
  const s=state(),active=structuredClone(s.active);expect(Object.keys(emailConnections(s))).toEqual(['current-relay']);expect(s.active).toEqual(active);
  expect(publicEmailConnections(s)[0]).toMatchObject({name:'OneHR',active:true,hasPassword:true});expect(JSON.stringify(publicEmailConnections(s))).not.toContain('fictional-old-secret');
 });
 it('preserves existing operator drafts when the list is introduced',()=>{
  const s={...state(),drafts:{operator:{config,password:'fictional-draft-secret',id:'old-draft',testedAt:12}}};
  const rows=publicEmailConnections(s);expect(rows).toHaveLength(2);expect(rows.map(r=>r.name)).toEqual(['OneHR','OneHR (2)']);expect(JSON.stringify(rows)).not.toContain('fictional-draft-secret');
 });
 it('saves multiple connections but leaves the current sender active until tested activation',()=>{
  const s=state(),before=structuredClone(s.active);emailConnections(s);
  const saved=saveEmailConnection(s,{name:'Backup',config,password:'fictional-new-secret',revision:s.revision});
  expect(publicEmailConnections(s)).toHaveLength(2);expect(s.active).toEqual(before);
  expect(()=>activateEmailConnection(s,saved.id,saved.version,'operator',true)).toThrow();
  saved.testedAt=100_000;saved.testedBy='operator';activateEmailConnection(s,saved.id,saved.version,'operator',true,100_001);
  expect(s.activeConnectionId).toBe(saved.id);expect(s.active?.password).toBe('fictional-new-secret');expect(publicEmailConnections(s).filter(r=>r.active)).toHaveLength(1);
 });
 it('does not borrow credentials from another connection, and rejects changed mailbox identity',()=>{
  const s=state();emailConnections(s);
  expect(()=>saveEmailConnection(s,{name:'New',config,revision:s.revision})).toThrow();
  expect(()=>saveEmailConnection(s,{id:'current-relay',name:'OneHR',config:{...config,user:'other@example.test'},revision:s.revision})).toThrow();
  expect(saveEmailConnection(s,{id:'current-relay',name:'OneHR',config,revision:s.revision}).password).toBe('fictional-old-secret');
 });
 it('invalidates tested changes and refuses stale versions, another operator receipt, or expired proof',()=>{
  const s=state();emailConnections(s);const c=saveEmailConnection(s,{id:'current-relay',name:'OneHR',config,revision:s.revision});c.testedAt=100_000;c.testedBy='operator';
  expect(()=>activateEmailConnection(s,c.id,c.version,'other',true,100_001)).toThrow();expect(()=>activateEmailConnection(s,c.id,c.version,'operator',false,100_001)).toThrow();expect(()=>activateEmailConnection(s,c.id,c.version,'operator',true,2_000_001)).toThrow();
  const updated=saveEmailConnection(s,{id:c.id,name:'Renamed',config,revision:s.revision});expect(updated.testedAt).toBeNull();expect(()=>testedEmailConnection(s,c.id,c.version)).toThrow();
  expect(publicEmailConnections(s).find(r=>r.id===c.id)?.hasUnappliedChanges).toBe(true);
 });
 it('rejects stale editors and object-prototype identifiers',()=>{
  const s=state();emailConnections(s);expect(()=>saveEmailConnection(s,{id:'current-relay',name:'OneHR',config,revision:'stale'})).toThrow();
  expect(()=>saveEmailConnection(s,{id:'__proto__',name:'Invalid',config,revision:s.revision})).toThrow();expect(()=>testedEmailConnection(s,'constructor','x')).toThrow();
 });
});
