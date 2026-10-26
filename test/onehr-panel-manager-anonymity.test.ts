/**
 * D-TM-01 (P1, anonymity). Every read and write below runs through `withTenant`, i.e. as the application role
 * `ai_hr_app` (NOBYPASSRLS) under each persona's GUCs; the first case pins that. `owner` only seeds and observes.
 *
 * Before 0620 the `onehr_panel_read` policy admitted the subject's line manager, so a manager could SELECT each
 * rater's identity, answers and remark directly, even below the anonymity minimum. The manager now reads panel
 * membership only through `app.onehr_manager_panel` and changes unsubmitted members only through
 * `app.onehr_manager_panel_member`; subjects, raters and scoped HR keep exactly their previous access.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { setReportingLine } from '../core/org';
import * as perf from '../packs/performance/service';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { adminCtx, closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';

vi.mock('../lib/ai',async importActual=>({...await importActual<typeof import('../lib/ai')>(),generateDraft:vi.fn(),readImage:vi.fn()}));
vi.mock('../core/ai-config',async importActual=>({...await importActual<typeof import('../core/ai-config')>(),resolveActiveAiConfig:vi.fn()}));
import { resolveActiveAiConfig } from '../core/ai-config';
import { createOnehrServiceFixtures, year } from './onehr-service-fixture';

const REMARK=(i:number)=>`Rater remark marker ${i}`;
const MEMBER_COLUMNS=['archive_reason','archived_at','peer_employment_id','relationship','request_id','reset_at','submitted_at'];

describe('D-TM-01: a line manager cannot read raw 360 panel rows',()=>{
  let b:Base,a:SessionContext,subject:{employmentId:string;personId:string},manager:{employmentId:string;personId:string},self:SessionContext,mgr:SessionContext,cycleId:string,reviewId:string;
  let peers:{employmentId:string;ctx:SessionContext}[];
  const {hire,view}=createOnehrServiceFixtures({get b(){return b;},get a(){return a;},get subject(){return subject;},get manager(){return manager;},get self(){return self;},get mgr(){return mgr;},get cycleId(){return cycleId;},get reviewId(){return reviewId;},get peers(){return peers;}});

  const rawPanel=(ctx:SessionContext)=>withTenant(ctx,tx=>tx.select().from(schema.onehrPanel).where(eq(schema.onehrPanel.reviewId,reviewId)));
  const allRawPanel=(ctx:SessionContext)=>withTenant(ctx,tx=>tx.select().from(schema.onehrPanel));
  // The reverification's reproduction query, verbatim in shape.
  const reproduction=(ctx:SessionContext)=>withTenant(ctx,tx=>tx.execute(sql`select pe.peer_name,p.answers,p.remark from performance_onehr_panel p join peer_feedback_request pe on pe.id=p.request_id where p.review_id=${reviewId}::uuid`));
  const membership=(ctx:SessionContext)=>withTenant(ctx,tx=>tx.execute<Record<string,unknown>>(sql`select * from app.onehr_manager_panel(${reviewId}::uuid) order by request_id`));
  const setMember=(ctx:SessionContext,requestId:string,archived:boolean,relationship:string|null=null)=>withTenant(ctx,tx=>tx.execute(sql`select app.onehr_manager_panel_member(${requestId}::uuid,${archived}::boolean,${relationship}::text)`));
  const refused=(pattern:RegExp)=>({cause:expect.objectContaining({message:expect.stringMatching(pattern)})});
  const ownedRows=()=>owner.db.select().from(schema.onehrPanel).where(eq(schema.onehrPanel.reviewId,reviewId));
  async function assignAll(){await perf.assignOnehrPanel(mgr,reviewId,(await view()).revision,peers.map(p=>({employmentId:p.employmentId,relationship:'peer'})));}
  async function submit(i:number){
    const request=(await perf.onehrAssignments(peers[i].ctx)).feedback.find(r=>r.subject==='Assessment subject')!;
    const card=await perf.getOnehrFeedback(peers[i].ctx,request.id);
    await perf.submitOnehrFeedback(peers[i].ctx,request.id,Object.fromEntries(card.statements.map(s=>[s.id,'yes'])),REMARK(i));
  }

  beforeEach(async()=>{
    vi.mocked(resolveActiveAiConfig).mockReset().mockResolvedValue(null);
    await resetDb();b=await seedBase();a=adminCtx(b);await setModule(b.tenantId,'performance','active');a=await entitledCtx(b);
    subject=await hire('Assessment subject');manager=await hire('Assessment manager');
    const ctx=async(personId:string,role:'employee'|'manager'):Promise<SessionContext>=>({...a,userId:await createAppUser(b.tenantId,personId,role),personId,roles:[role],grants:undefined});
    self=await ctx(subject.personId,'employee');mgr=await ctx(manager.personId,'manager');
    peers=[];for(let i=0;i<4;i++){const h=await hire(`Peer ${i}`);peers.push({employmentId:h.employmentId,ctx:await ctx(h.personId,'employee')});}
    const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Grade 12'}).returning();
    for(const e of [subject,manager,...peers])await owner.db.update(schema.employment).set({gradeId:grade.id}).where(eq(schema.employment.id,e.employmentId));
    for(const e of [subject,...peers])await setReportingLine(a,{subordinateEmploymentId:e.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:`${year-2}-01-01`});
    ({cycleId}=await perf.createCycle(a,{name:'Native annual assessment',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`}));
    const policy=defaultPolicy(framework);
    expect(policy.minValid).toBe(4);
    await perf.configureOnehrCycle(a,cycleId,null,policy);await perf.openCycle(a,{cycleId});
    const [r]=await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycleId),eq(schema.performanceReview.employmentId,subject.employmentId)));reviewId=r.id;
  });
  afterAll(closeAll);

  it('returns no raw panel rows to the line manager below or at the minimum, and keeps subject, rater and HR access unchanged',async()=>{
    for(const ctx of [mgr,self,peers[0].ctx,a]){
      const [who]=await withTenant(ctx,tx=>tx.execute<{role:string;bypass:boolean}>(sql`select current_user as role,(select rolbypassrls from pg_roles where rolname=current_user) as bypass`));
      expect(who).toEqual({role:'ai_hr_app',bypass:false});
    }
    expect((await view(mgr)).manager).toBe(true);expect((await view(a)).admin).toBe(true);expect((await view(a)).manager).toBe(false);
    await assignAll();
    expect(await ownedRows()).toHaveLength(4);
    await submit(0); // One valid submission of the minimum four.
    expect(await rawPanel(mgr)).toEqual([]);expect(await allRawPanel(mgr)).toEqual([]);expect(await reproduction(mgr)).toHaveLength(0);
    for(let i=1;i<4;i++)await submit(i); // At the minimum.
    expect((await ownedRows()).filter(r=>r.submittedAt)).toHaveLength(4);
    expect(await rawPanel(mgr)).toEqual([]);expect(await allRawPanel(mgr)).toEqual([]);expect(await reproduction(mgr)).toHaveLength(0);
    expect(await rawPanel(self)).toEqual([]);expect(await reproduction(self)).toHaveLength(0);
    for(let i=0;i<4;i++){
      const own=await rawPanel(peers[i].ctx);
      expect(own.map(r=>[r.peerEmploymentId,r.remark])).toEqual([[peers[i].employmentId,REMARK(i)]]);
      expect(await reproduction(peers[i].ctx)).toHaveLength(1);
    }
    const hr=await rawPanel(a);
    expect(hr.map(r=>r.remark).sort()).toEqual([0,1,2,3].map(REMARK));expect(hr.every(r=>r.answers&&r.submittedAt)).toBe(true);
    expect(await reproduction(a)).toHaveLength(4);
  });

  it('gives the manager no blind UPDATE path to rater content of rows it cannot read',async()=>{
    await assignAll();
    const blind=await withTenant(mgr,tx=>tx.execute(sql`update performance_onehr_panel set remark='Overwritten by the manager'`));
    expect(blind.count).toBe(0);
    expect(await withTenant(mgr,tx=>tx.update(schema.onehrPanel).set({remark:'Overwritten by the manager'}).where(eq(schema.onehrPanel.reviewId,reviewId)).returning())).toEqual([]);
    expect((await ownedRows()).map(r=>r.remark)).toEqual(['','','','']);
    // Raters and scoped HR keep their UPDATE paths: a rater declines their own card; HR archives through the panel controls.
    const request=(await perf.onehrAssignments(peers[0].ctx)).feedback[0];await perf.declineOnehrFeedback(peers[0].ctx,request.id);
    const member=(await view(a)).peers.find(p=>p.employmentId===peers[1].employmentId)!;
    await perf.changeAssessmentPanelState(a,reviewId,(await view(a)).revision,member.requestId,'archive','HR fixture');
    expect((await ownedRows()).filter(r=>r.archivedAt).map(r=>r.peerEmploymentId).sort()).toEqual([peers[0].employmentId,peers[1].employmentId].sort());
  });

  it('exposes panel membership and status to the line manager only, never answers or remarks',async()=>{
    await assignAll();await submit(0);
    const rows=await membership(mgr);
    expect(rows).toHaveLength(4);
    for(const row of rows)expect(Object.keys(row).sort()).toEqual(MEMBER_COLUMNS);
    expect(rows.filter(r=>r.submitted_at!=null)).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('Rater remark marker');
    expect(rows.map(r=>r.peer_employment_id).sort()).toEqual(peers.map(p=>p.employmentId).sort());
    for(const ctx of [self,a,...peers.map(p=>p.ctx)])expect(await membership(ctx)).toEqual([]);
    const other=await seedBase();expect(await membership(adminCtx(other))).toEqual([]);
    const fns=await owner.db.execute<{name:string;definer:boolean;config:string[]|null;app:boolean;public:boolean}>(sql`select p.proname as name,p.prosecdef as definer,p.proconfig as config,has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app,exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x where x.grantee=0 and x.privilege_type='EXECUTE') as public from pg_proc p where p.oid in ('app.onehr_manager_panel(uuid)'::regprocedure,'app.onehr_manager_panel_member(uuid,boolean,text)'::regprocedure) order by p.proname`);
    expect([...fns].map(f=>({...f,config:f.config?.map(v=>v.replaceAll(' ',''))}))).toEqual(['onehr_manager_panel','onehr_manager_panel_member'].map(name=>({name,definer:true,config:['search_path=pg_catalog,public,pg_temp'],app:true,public:false})));

    // The membership writer touches only unsubmitted members of the manager's own reviews.
    const submitted=String(rows.find(r=>r.submitted_at!=null)!.request_id),pending=String(rows.find(r=>r.submitted_at==null)!.request_id);
    await expect(setMember(mgr,submitted,true)).rejects.toMatchObject(refused(/not available to this manager/));
    for(const ctx of [self,a,...peers.map(p=>p.ctx)])await expect(setMember(ctx,pending,true)).rejects.toMatchObject(refused(/not available to this manager/));
    await setMember(mgr,pending,true,'matrix_manager');
    let [stored]=await owner.db.select().from(schema.onehrPanel).where(eq(schema.onehrPanel.requestId,pending));
    expect(stored.archivedAt).not.toBeNull();expect(stored.relationship).toBe('matrix_manager');expect(stored.answers).toBeNull();expect(stored.remark).toBe('');
    await setMember(mgr,pending,false,'peer');
    [stored]=await owner.db.select().from(schema.onehrPanel).where(eq(schema.onehrPanel.requestId,pending));
    expect(stored.archivedAt).toBeNull();expect(stored.relationship).toBe('peer');
    const [kept]=await owner.db.select().from(schema.onehrPanel).where(eq(schema.onehrPanel.requestId,submitted));
    expect(kept.archivedAt).toBeNull();expect(kept.remark).toBe(REMARK(0));
  });

  it('keeps the manager review screen and panel assignment output unchanged',async()=>{
    await assignAll();await submit(0);await submit(1);
    const managerPeers=(await view(mgr)).peers,adminPeers=(await view(a)).peers;
    expect(managerPeers.map(p=>p.name)).toEqual(['Peer 0','Peer 1','Peer 2','Peer 3']);
    expect(managerPeers.filter(p=>p.submittedAt instanceof Date)).toHaveLength(2);
    expect(managerPeers).toEqual(adminPeers.filter(p=>!p.archivedAt));
    expect(JSON.stringify(managerPeers)).not.toMatch(/Rater remark marker|"yes"/);
    expect((await view(self)).peers).toEqual([]);

    // A submitted reviewer cannot be dropped; an unsubmitted one is replaced, then restored on the same request.
    await expect(perf.assignOnehrPanel(mgr,reviewId,(await view()).revision,peers.slice(1).map(p=>({employmentId:p.employmentId,relationship:'peer'})))).rejects.toThrow(/Submitted reviewers must remain/);
    const dropped=managerPeers.find(p=>p.employmentId===peers[3].employmentId)!.requestId;
    await perf.assignOnehrPanel(mgr,reviewId,(await view()).revision,[{employmentId:manager.employmentId,relationship:'line_manager'},...peers.slice(0,3).map(p=>({employmentId:p.employmentId,relationship:'peer'}))]);
    const replaced=(await view(mgr)).peers;
    expect(replaced.map(p=>[p.name,p.relationship])).toEqual([['Assessment manager','line_manager'],['Peer 0','peer'],['Peer 1','peer'],['Peer 2','peer']]);
    expect(replaced).toEqual((await view(a)).peers.filter(p=>!p.archivedAt));
    expect((await view(a)).peers.find(p=>p.requestId===dropped)!.archivedAt).toBeInstanceOf(Date);
    const status=async(id:string)=>(await owner.db.select({status:schema.peerFeedbackRequest.status}).from(schema.peerFeedbackRequest).where(eq(schema.peerFeedbackRequest.id,id)))[0].status;
    expect(await status(dropped)).toBe('declined');
    expect((await perf.onehrAssignments(peers[3].ctx)).feedback).toEqual([]);
    // The line manager is now also a rater: the own-card arm shows them exactly their own row.
    const own=await rawPanel(mgr);expect(own.map(r=>[r.peerEmploymentId,r.relationship])).toEqual([[manager.employmentId,'line_manager']]);

    await perf.assignOnehrPanel(mgr,reviewId,(await view()).revision,[{employmentId:manager.employmentId,relationship:'line_manager'},...peers.map(p=>({employmentId:p.employmentId,relationship:'peer'}))]);
    const restored=(await view(mgr)).peers;
    expect(restored.find(p=>p.employmentId===peers[3].employmentId)).toMatchObject({requestId:dropped,archivedAt:null,submittedAt:null});
    expect(restored).toHaveLength(5);expect(restored).toEqual((await view(a)).peers.filter(p=>!p.archivedAt));
    expect(await status(dropped)).toBe('pending');
    expect((await perf.onehrAssignments(peers[3].ctx)).feedback.map(f=>f.id)).toEqual([dropped]);
    expect((await ownedRows()).filter(r=>r.peerEmploymentId===peers[3].employmentId)).toHaveLength(1);
  });
});
