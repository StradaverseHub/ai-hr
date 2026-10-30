import {randomUUID} from 'node:crypto';
import {visibleRecentJoiner} from '../lib/onboarding-model';
import { afterAll, beforeEach, describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { saveEmployeeDraft, discardEmployeeDraft, completeEmployeeDraft } from '../core/employee-draft';
import { hireEmployee } from '../core/org';
import { onboardingSetup, onboardingContext, onboardingList, onboardingDetail, onboardingCommand, onboardingSaveConfig, onboardingSaveChecklistTasks, onboardingTasks, onboardingAssignedTaskMetadata, onboardingNote, sweepOnboarding, onboardingNotices, onboardingReadNotice, createOnboardingCase, caseHistory, refreshOnboardingPersonnel, onboardingSyncDraftTx, onboardingRequisitions, onboardingNavigation } from '../packs/lifecycle/service';
import { appendEvent, actorOf } from '../db/events';
import { closeAll, resetDb, seedBase, setModule, entitledCtx, owner, createAppUser, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';
import { dayDate } from '../lib/onboarding-model';
describe('V3.1 onboarding database and authorization', () => {
    let b: Base, admin: SessionContext, tech: SessionContext, other: SessionContext;
    beforeEach(async () => {
        await resetDb();
        b = await seedBase();
        await setModule(b.tenantId, 'lifecycle', 'active');
        admin = await entitledCtx(b);
        const hired = await hireEmployee(admin, { companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: dayDate(todayInKualaLumpur(), -30), person: { fullName: 'Kevin Tech', primaryEmail: 'kevin@test.invalid' } });
        const user = await createAppUser(b.tenantId, hired.personId, 'employee');
        tech = { ...admin, userId: user, personId: hired.personId, roles: ['employee'], grants: undefined };
        const hired2 = await hireEmployee(admin, { companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: dayDate(todayInKualaLumpur(), -30), person: { fullName: 'Other Employee', primaryEmail: 'other@test.invalid' } });
        other = { ...tech, userId: await createAppUser(b.tenantId, hired2.personId, 'employee'), personId: hired2.personId };
        await onboardingSetup(admin);
        const context = await onboardingContext(admin), config = structuredClone(context.config);
        config.groups.find(g => g.id === 'group-tech')!.members = [user];
        config.groups.find(g => g.id === 'people-gbs')!.members = [user];
        config.groups.find(g => g.id === 'tech-bp')!.members = [user];
        config.checklists[0]!.tasks = [{ id: 'welcome', name: 'Prepare welcome pack', by: 'group', group: 'people-gbs', method: 'rr', opens: null, due: 1, gate: false }];
        config.catalogue = [{ id: 'm365', name: 'M365', type: 'system', active: true, rules: {}, workflow: null, team: 'group-tech', card: false }];
        await onboardingSaveConfig(admin, context.revision, config);
    });
    afterAll(closeAll);
    const draft = () => saveEmployeeDraft(admin, { data: { profile: { fullName: 'New Hire', primaryEmail: 'new@test.invalid', icNumber: 'PRIVATE-IC' }, employment: { companyId: b.companyId, departmentId: b.deptA, positionId: b.positionId, hiredOn: dayDate(todayInKualaLumpur(), 8) } }, currentStep: 1 });
    async function prepared() {
        await draft();
        let [row] = await onboardingList(admin);
        await onboardingCommand(admin, row!.case.id, row!.revision, { type: 'save', patch: { hiring: 'new_hire', local: { supervisor: 'Manager' }, selected: ['m365'] } });
        [row] = await onboardingList(admin);
        await onboardingCommand(admin, row!.case.id, row!.revision, { type: 'submit' });
        return (await onboardingList(admin))[0]!;
    }
    it('projects only actual unlocked personal work for Home and removes a completed checklist task', async()=>{
        const row=await prepared(),tasks=await onboardingTasks(tech),assigned=await onboardingAssignedTaskMetadata(tech);
        const welcome=tasks.find(item=>item.caseId===row.case.id&&item.taskId==='welcome')!;
        expect(assigned.find(item=>item.id===welcome.id)).toMatchObject({kind:'onboarding',dueDate:welcome.due,linkPath:'/tasks#'+encodeURIComponent('onboarding-'+welcome.id)});
        expect(assigned.every(item=>tasks.some(task=>task.id===item.id&&task.assigned&&!task.locked))).toBe(true);
        expect(await onboardingAssignedTaskMetadata(other)).toEqual([]);
        expect(JSON.stringify(assigned)).not.toContain('PRIVATE-IC');
        await onboardingCommand(tech,row.case.id,row.revision,{type:'task',taskId:'welcome',status:'done'});
        expect((await onboardingAssignedTaskMetadata(tech)).some(item=>item.id===welcome.id)).toBe(false);
    });
    it('counts the same visible joiners and checklists as the authorized module without leaking counts to task-only users', async()=>{
        await draft();
        expect(await onboardingNavigation(admin)).toMatchObject({module:true,joiners:1,checklists:1});
        expect(await onboardingNavigation(tech)).toMatchObject({module:false,joiners:0,checklists:0});
        expect(await onboardingNavigation(other)).toMatchObject({module:false,joiners:0,checklists:0});
    });
    it('keeps SQL navigation counts in parity with the canonical model across historical states', async()=>{
        const row=await prepared(),today=todayInKualaLumpur(),context=await onboardingContext(admin);
        const original=structuredClone(row.case);
        const examples=[original];
        for(const state of ['pending','submitted','cancelled'] as const)for(const draft of [true,false])for(const recent of [true,false]){
            const c=structuredClone(original);c.id=randomUUID();c.sourceDraftId=null;c.state=state;c.personnelStatus=draft?'Draft':'Active';
            c.source.joinDate=dayDate(today,recent?1:-1000);c.local.joinDate=dayDate(today,100);
            c.tasks.forEach(task=>task.status='done');c.requisitions.forEach(req=>req.handedAt=new Date().toISOString());examples.push(c);
        }
        const unfinished=structuredClone(examples.find(c=>c.state==='submitted'&&c.personnelStatus==='Active')!);
        unfinished.id=randomUUID();unfinished.source.joinDate=dayDate(today,-1000);unfinished.tasks[0]!.status='todo';examples.push(unfinished);
        const open=structuredClone(unfinished);open.id=randomUUID();open.tasks.forEach(task=>task.status='done');open.requisitions[0]!.handedAt=null;examples.push(open);
        // SQL NULL is neither equal nor unequal. The original owner treats an absent
        // legacy status as unfinished, and an absent state as not cancelled.
        const legacyTask=structuredClone(unfinished);legacyTask.id=randomUUID();
        legacyTask.tasks[0]!.assignee=admin.userId!;legacyTask.tasks[0]!.gate=false;
        Reflect.deleteProperty(legacyTask.tasks[0]!,'status');examples.push(legacyTask);
        const legacyState=structuredClone(unfinished);legacyState.id=randomUUID();
        Reflect.deleteProperty(legacyState,'state');examples.push(legacyState);
        const completed=examples.find(c=>c.state==='submitted'&&c.personnelStatus==='Active'&&c.tasks.every(task=>task.status==='done')&&c.requisitions.every(req=>!!req.handedAt))!;
        const unknownDate=structuredClone(completed);unknownDate.id=randomUUID();
        Reflect.set(unknownDate.source,'joinDate',null);examples.push(unknownDate);
        const inheritedDate=structuredClone(completed);inheritedDate.id=randomUUID();
        Reflect.deleteProperty(inheritedDate.source,'joinDate');examples.push(inheritedDate);
        for(const c of examples.slice(1))await owner.db.insert(schema.lcOnboardingCase).values({id:c.id,tenantId:b.tenantId,companyId:b.companyId,sourceDraftId:null,data:c});
        expect((await onboardingNavigation(admin)).joiners).toBe(examples.filter(c=>visibleRecentJoiner(context.config,c,today)).length);
        expect((await onboardingNavigation(other)).joiners).toBe(0);
        expect((await onboardingTasks(admin)).some(task=>task.caseId===legacyTask.id&&task.taskId===legacyTask.tasks[0]!.id&&task.assigned)).toBe(true);
    });
    it('retains unresolved mentions on completed cases but excludes resolved, deleted and cancelled history',async()=>{
        const row=await prepared();
        await onboardingNote(admin,row.case.id,{context:'requisition',body:'Current mention',mentions:[tech.userId!]});
        const data=structuredClone((await onboardingDetail(admin,row.case.id)).case);
        data.personnelStatus='Active';data.source.joinDate=dayDate(todayInKualaLumpur(),-1000);data.tasks.forEach(task=>task.status='done');
        data.requisitions.forEach(req=>req.handedAt=new Date().toISOString());
        await owner.db.update(schema.lcOnboardingCase).set({data}).where(eq(schema.lcOnboardingCase.id,row.case.id));
        const before=await onboardingTasks(tech);
        expect(before.filter(task=>task.caseId===row.case.id).map(task=>task.kind)).toEqual(['mention']);
        const [note]=await owner.db.select().from(schema.lcOnboardingNote).where(eq(schema.lcOnboardingNote.caseId,row.case.id));
        await onboardingNote(tech,row.case.id,{id:note.id,context:'requisition',body:note.data.body,mentions:note.data.mentions,resolve:true});
        expect((await onboardingTasks(tech)).filter(task=>task.caseId===row.case.id)).toEqual([]);
        await onboardingNote(admin,row.case.id,{id:note.id,context:'requisition',body:'',mentions:[],deleted:true});
        expect((await onboardingTasks(tech)).filter(task=>task.caseId===row.case.id)).toEqual([]);
        await onboardingNote(admin,row.case.id,{context:'requisition',body:'Another mention',mentions:[tech.userId!]});
        await owner.db.update(schema.lcOnboardingCase).set({data:{...data,state:'cancelled'}}).where(eq(schema.lcOnboardingCase.id,row.case.id));
        expect((await onboardingTasks(tech)).filter(task=>task.caseId===row.case.id)).toEqual([]);
    });

    it('saves task definitions alone, checks revisions and preserves other configuration', async () => {
        const before = await onboardingContext(admin), checklist = before.config.checklists[0]!;
        const tasks = structuredClone(checklist.tasks);
        tasks[0]!.name = 'Updated task only';
        expect(await onboardingSaveChecklistTasks(admin, before.revision, checklist.id, tasks)).toEqual({ revision: before.revision + 1 });
        const after = await onboardingContext(admin);
        expect(after.config).toEqual({ ...before.config, checklists: before.config.checklists.map(c => c.id === checklist.id ? { ...c, tasks } : c) });
        await expect(onboardingSaveChecklistTasks(admin, before.revision, checklist.id, tasks)).rejects.toThrow('Settings changed');
        await expect(onboardingSaveChecklistTasks(tech, after.revision, checklist.id, tasks)).rejects.toThrow('Onboarding access');
    });
    it('keeps operational requisition visibility after a Facility-to-Tech handoff without widening action rights', async () => {
        const context = await onboardingContext(admin), config = structuredClone(context.config);
        config.groups.find(g => g.id === 'facility')!.members = [other.userId!];
        config.catalogue.push({ id: 'card', name: 'Access card', type: 'device', active: true, rules: {}, workflow: null, team: 'facility', card: true });
        await onboardingSaveConfig(admin, context.revision, config);
        const row = await prepared();
        await onboardingCommand(admin, row.case.id, row.revision, { type: 'save', patch: { selected: ['m365', 'card'] } });
        const facility = await onboardingDetail(other, row.case.id, 'requisition');
        const card = facility.case.requisitions.find(r => !r.cancelledAt)!.items.find(i => i.catalogueId === 'card')!;
        await onboardingCommand(other, row.case.id, facility.revision, { type: 'fulfil', itemId: card.id, status: 'done' });
        const printed = await onboardingDetail(other, row.case.id, 'requisition');
        expect(printed.case.requisitions[0]!.items.find(i => i.id === card.id)).toMatchObject({ state: 'printed', team: 'group-tech' });
        await expect(onboardingCommand(other, row.case.id, printed.revision, { type: 'fulfil', itemId: card.id, status: 'done' })).rejects.toThrow();
        expect((await onboardingRequisitions(other)).some(r => r.caseId === row.case.id)).toBe(true);
    });
    it('refreshes and dispatches through the scheduled service principal without a fabricated login', async () => {
        const saved = await draft();
        const [stored] = await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id,saved.id)).orderBy(schema.employeeDraft.id);
        const data = structuredClone(stored!.data) as {profile:{fullName:string}};
        data.profile.fullName = 'Updated by scheduled Personnel refresh';
        await owner.db.update(schema.employeeDraft).set({data,updatedAt:new Date(Date.now()+1000)}).where(eq(schema.employeeDraft.id,saved.id));
        const [baseline] = await owner.db.insert(schema.employeeDraft).values({tenantId:b.tenantId,companyId:b.companyId,label:'Draft predating setup',data:{profile:{fullName:'Draft predating setup'},employment:{companyId:b.companyId}},currentStep:1}).returning();
        const system:SessionContext = {tenantId:b.tenantId,roles:['hr_admin'],entitlements:admin.entitlements};
        await expect(refreshOnboardingPersonnel(system)).rejects.toThrow('Scheduled Personnel synchronisation requires the storage owner.');
        await refreshOnboardingPersonnel(system,owner.withTenant);
        const all = await onboardingList(admin);
        const row = all.find(row => row.case.sourceDraftId === saved.id)!;
        expect(row.case.source.fullName).toBe(data.profile.fullName);
        expect(row.case.personId).toBeNull(); expect(row.case.employmentId).toBeNull();
        const backfilled = all.find(row => row.case.sourceDraftId === baseline!.id)!;
        expect(backfilled.case.number).not.toBe(row.case.number);
        expect(backfilled.case.history.some(entry => entry.by === 'system')).toBe(true);
        await expect(withTenant({...system,roles:['employee']},tx=>tx.execute(sql`select app.onboarding_next_case_number('2026')`))).rejects.toThrow();
        await expect(withTenant(system,tx=>tx.execute(sql`select app.onboarding_next_case_number('not-a-year')`))).rejects.toThrow();
        expect((await sweepOnboarding(system)).created).toBeGreaterThan(0);
        expect((await onboardingNotices(admin)).length).toBeGreaterThan(0);
    });
    it('keeps one case and the latest Personnel source during concurrent save and backfill', async () => {
        const [stored] = await owner.db.insert(schema.employeeDraft).values({tenantId:b.tenantId,companyId:b.companyId,label:'Existing baseline draft',data:{profile:{fullName:'Existing baseline draft'},employment:{companyId:b.companyId}},currentStep:1}).returning();
        const system:SessionContext = {tenantId:b.tenantId,roles:['hr_admin'],entitlements:admin.entitlements};
        const attempts = await Promise.allSettled([
            refreshOnboardingPersonnel(system,owner.withTenant),
            saveEmployeeDraft(admin,{id:stored!.id,data:{profile:{fullName:'Latest concurrent Personnel name'},employment:{companyId:b.companyId}},currentStep:1})
        ]);
        expect(attempts.map(result => result.status)).toEqual(['fulfilled','fulfilled']);
        const rows = await onboardingList(admin);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.case.sourceDraftId).toBe(stored!.id);
        expect(rows[0]!.case.source.fullName).toBe('Latest concurrent Personnel name');
    });
    it('d839ff30: a save already holding the audit chain and a starting backfill cannot deadlock', async () => {
        // The interleaving the full gate hit as 40P01, forced instead of hoped for. The save has appended its
        // event, so it holds the tenant's audit-chain lock, and only then asks for the onboarding lock; the
        // backfill starts in between. Before d839ff30 the backfill took the onboarding lock and then waited on
        // the audit chain, so each waited on the other. Now it queues on the audit chain first and holds nothing.
        const [stored] = await owner.db.insert(schema.employeeDraft).values({tenantId:b.tenantId,companyId:b.companyId,label:'Forced interleaving draft',data:{profile:{fullName:'Forced interleaving draft'},employment:{companyId:b.companyId}},currentStep:1}).returning();
        const system:SessionContext = {tenantId:b.tenantId,roles:['hr_admin'],entitlements:admin.entitlements};
        let appended!: () => void, proceed!: () => void;
        const holding = new Promise<void>(resolve => { appended = resolve; }), go = new Promise<void>(resolve => { proceed = resolve; });
        const save = withTenant(admin, async (tx) => {
            await appendEvent(tx, { tenantId: b.tenantId, aggregateType: 'employee-draft', aggregateId: stored!.id, eventType: 'employee-draft.updated', actor: actorOf(admin), payload: {} });
            appended();
            await go;
            await onboardingSyncDraftTx(admin, tx, stored!.id, 'save');
        });
        await Promise.race([holding, save]);
        const backfill = refreshOnboardingPersonnel(system,owner.withTenant);
        // Wait until the backfill is actually blocked on an advisory lock, so the save resumes into the
        // contested window every time rather than on a lucky schedule.
        let observationError:unknown;
        try {
            const deadline = Date.now() + 10_000;
            for (;;) {
                const [{ n }] = await owner.db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`) as unknown as { n: number }[];
                if (n > 0) break;
                if (Date.now() > deadline) throw new Error('the backfill never queued on an advisory lock; the interleaving was not reached');
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        } catch(error){observationError=error;} finally {proceed();}
        const attempts = await Promise.allSettled([save, backfill]);
        if(observationError)throw observationError;
        expect(attempts.map(result => result.status === 'rejected' ? String((result.reason as Error)?.cause ?? result.reason) : 'fulfilled')).toEqual(['fulfilled','fulfilled']);
        expect((await onboardingList(admin)).filter(row => row.case.sourceDraftId === stored!.id)).toHaveLength(1);
    });
    it('automatically creates one pending case, saves incomplete data and protects source identity', async () => {
        const d = await draft();
        const rows = await onboardingList(admin);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.case).toMatchObject({ sourceDraftId: d.id, state: 'pending', requisitions: [] });
        await saveEmployeeDraft(admin, { id: d.id, data: { profile: { fullName: 'Updated Hire', primaryEmail: 'new@test.invalid' }, employment: { companyId: b.companyId } }, currentStep: 1 });
        expect(await onboardingList(admin)).toHaveLength(1);
        expect((await onboardingList(admin))[0]!.case.source.fullName).toBe('Updated Hire');
    });
    it('preserves the same case when Personnel activates its draft', async () => {
        const saved = await saveEmployeeDraft(admin, { data: { profile: { fullName: 'Activation Hire', employeeCode: 'ONB-ACT-1', primaryEmail: 'activation@test.invalid' }, employment: { companyId: b.companyId, departmentId: b.deptA, positionId: b.positionId, employmentType: 'full_time', hiredOn: todayInKualaLumpur() }, payroll: { basicSalary: '5000' } }, currentStep: 5 });
        const before = (await onboardingList(admin))[0]!;
        const active = await completeEmployeeDraft(admin, saved.id);
        const after = (await onboardingList(admin))[0]!;
        expect(after.case).toMatchObject({ id: before.case.id, sourceDraftId: saved.id, employmentId: active.employmentId, personnelStatus: 'Active' });
        expect(await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id, saved.id))).toHaveLength(0);
        expect((await owner.db.select().from(schema.lcOnboardingCaseRevision)).some(r => r.data.personnelStatus === 'Draft')).toBe(true);
    });
    it('links tasks when the login is created after activation without a Personnel field change', async () => {
        const context = await onboardingContext(admin), config = structuredClone(context.config);
        config.checklists[0]!.tasks.push({ id: 'acceptance', name: 'Device acknowledgement', by: 'joiner', group: '', method: 'manual', opens: 1, due: 1, gate: true });
        await onboardingSaveConfig(admin, context.revision, config);
        const saved = await saveEmployeeDraft(admin, { data: { profile: { fullName: 'Late account hire', employeeCode: 'LATE-LOGIN-1', primaryEmail: 'late-login@test.invalid' }, employment: { companyId: b.companyId, departmentId: b.deptA, positionId: b.positionId, employmentType: 'full_time', hiredOn: todayInKualaLumpur() }, payroll: { basicSalary: '5000' } }, currentStep: 5 });
        const active = await completeEmployeeDraft(admin, saved.id);
        let row = (await onboardingList(admin))[0]!;
        await onboardingCommand(admin, row.case.id, row.revision, { type: 'saveSubmit', patch: { hiring: 'new_hire', local: { supervisor: 'Manager' }, selected: ['m365'] } });
        row = (await onboardingList(admin))[0]!;
        expect(row.case.tasks.find(t => t.id === 'acceptance')?.assignee).toBeNull();
        const [employee] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, active.employmentId));
        const user = await createAppUser(b.tenantId, employee!.personId, 'employee');
        await refreshOnboardingPersonnel(admin);
        row = (await onboardingList(admin))[0]!;
        expect(row.case.tasks.find(t => t.id === 'acceptance')).toMatchObject({ assignee: user, failure: null });
        const revision = row.revision;
        await refreshOnboardingPersonnel(admin);
        expect((await onboardingList(admin))[0]!.revision).toBe(revision);
        const joiner:SessionContext = {...tech,userId:user,personId:employee!.personId,roles:['employee'],grants:undefined};
        const acknowledgement = {type:'acknowledge' as const,data:{acknowledged:'true',contactNumber:'0100000000',serialNumber:'FICTIONAL-SERIAL'}};
        await expect(onboardingCommand(joiner,row.case.id,row.revision,acknowledgement)).rejects.toThrow('not available');
        await onboardingCommand(tech,row.case.id,row.revision,{type:'fulfil',itemId:row.case.requisitions[0]!.items[0]!.id,status:'done'});
        row=(await onboardingList(admin))[0]!;
        await onboardingCommand(tech,row.case.id,row.revision,{type:'handover'});
        row=(await onboardingList(admin))[0]!;
        await onboardingCommand(joiner,row.case.id,row.revision,acknowledgement);
        row=(await onboardingList(admin))[0]!;
        expect(row.case.tasks.find(t=>t.id==='acceptance')).toMatchObject({status:'done',completedBy:user});
        expect(row.case.acknowledgement?.by).toBe(user);
        const completedRevision=row.revision;
        await refreshOnboardingPersonnel(admin);
        expect((await onboardingList(admin))[0]!.revision).toBe(completedRevision);
        await expect(onboardingCommand(joiner,row.case.id,completedRevision,acknowledgement)).rejects.toThrow('not available');
    });
    it('keeps an incomplete join date save usable without breaking the task queue', async () => {
        await saveEmployeeDraft(admin, { data: { profile: { fullName: 'Unscheduled Hire' }, employment: { companyId: b.companyId } }, currentStep: 1 });
        const row = (await onboardingList(admin))[0]!;
        await onboardingCommand(admin, row.case.id, row.revision, { type: 'save', patch: { local: { joinDate: '12/' } } });
        const queue = await onboardingTasks(admin);
        expect(queue.find(t => t.kind === 'case')?.due).toBe('');
        expect((await onboardingDetail(admin, row.case.id)).case.local.joinDate).toBe('12/');
    });
    it('uses approved Leave dates without reviving a cancelled child date or exposing reasons', async () => {
        const [employee] = await owner.db.select().from(schema.employment).where(eq(schema.employment.personId, tech.personId!));
        const due = dayDate(todayInKualaLumpur(), 8), previous = dayDate(due, -1);
        const [leave] = await owner.db.insert(schema.leaveRequest).values({ tenantId: b.tenantId, employmentId: employee!.id, leaveTypeId: b.annualLeaveTypeId, startDate: previous, endDate: due, days: '1', status: 'approved', reason: 'PRIVATE MEDICAL DETAIL' }).returning();
        await owner.db.insert(schema.leaveRequestDate).values([{ tenantId: b.tenantId, leaveRequestId: leave!.id, subjectEmploymentId: employee!.id, leaveDate: previous, days: '1', status: 'approved' }, { tenantId: b.tenantId, leaveRequestId: leave!.id, subjectEmploymentId: employee!.id, leaveDate: due, days: '1', status: 'cancelled' }]);
        const availability = () => withTenant(admin, tx => tx.execute(sql `select * from app.onboarding_unavailable(array[${due}::date])`));
        expect(await availability()).toHaveLength(0);
        await owner.db.insert(schema.leaveRequest).values({ tenantId: b.tenantId, employmentId: employee!.id, leaveTypeId: b.annualLeaveTypeId, startDate: due, endDate: due, days: '0.5', durationType: 'half_day_am', status: 'approved', reason: 'PRIVATE MEDICAL DETAIL' });
        const unavailable = await availability();
        expect(unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ user_id: tech.userId })]));
        expect(JSON.stringify(unavailable)).not.toContain('PRIVATE');
    });
    it('does not expose a foreign person name through a malformed cross-tenant account link', async () => {
        const foreign = await seedBase();
        const foreignName = 'PRIVATE FOREIGN PERSON NAME';
        const [foreignPerson] = await owner.db.insert(schema.person).values({tenantId:foreign.tenantId,fullName:foreignName,primaryEmail:'foreign-person@onb-test.invalid'}).returning();
        // Deliberately use the owner to create a malformed link admitted by the global person FK.
        const mislinked = await createAppUser(b.tenantId, foreignPerson!.id, 'employee');
        const fallback = 'User ' + mislinked.slice(0,8);
        const directory = await withTenant(tech, tx => tx.execute(sql`select * from app.onboarding_directory()`)) as unknown as {id:string;name:string}[];
        expect(directory.find(user => user.id === mislinked)?.name).toBe(fallback);
        expect(directory.some(user => user.name === foreignName)).toBe(false);
        expect(directory.find(user => user.id === tech.userId)?.name).toBe('Kevin Tech');
        expect(directory.find(user => user.id === other.userId)?.name).toBe('Other Employee');
        const context = await onboardingContext({...tech,userId:mislinked,personId:foreignPerson!.id});
        expect(context.actor.name).toBe(fallback);
        expect(context.directory.find(user => user.id === mislinked)?.name).toBe(fallback);
    });
    it('hides foreign-tenant cases and labels even from another tenant administrator', async () => {
        const row = await prepared(), foreign = await seedBase();
        await setModule(foreign.tenantId, 'lifecycle', 'active');
        const foreignAdmin = await entitledCtx(foreign);
        expect(await withTenant(foreignAdmin, tx => tx.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id, row.case.id)))).toHaveLength(0);
        const labels = await withTenant(foreignAdmin, tx => tx.execute(sql `select app.onboarding_case_labels(${row.case.id}::uuid) as labels`));
        expect(labels[0]?.labels).toBeNull();
        await expect(onboardingCommand(foreignAdmin, row.case.id, row.revision, { type: 'cancel', reason: 'Unauthorized' })).rejects.toThrow('not found');
    });
    it('counts group-backed approval load separately from explicit person decisions', async () => {
        const context = await onboardingContext(admin), config = structuredClone(context.config);
        config.workflows[0]!.mode = 'par';
        config.workflows[0]!.steps.push({ id: 'person-only', label: 'Named person', type: 'person', target: tech.userId!, method: 'rr' });
        config.catalogue[0]!.workflow = config.workflows[0]!.id;
        await onboardingSaveConfig(admin, context.revision, config);
        await prepared();
        const loads = await withTenant(admin, tx => tx.execute(sql `select * from app.onboarding_assignment_loads() where user_id=${tech.userId}::uuid`));
        expect(Number(loads[0]!.pending_approvals)).toBe(1);
        expect(Number(loads[0]!.lifetime_approvals)).toBe(1);
    });
    it('keeps HR-only data in a separate RLS-protected record', async () => {
        const row = await prepared();
        const visible = await onboardingDetail(tech, row.case.id, 'task');
        expect(JSON.stringify(visible)).not.toContain('PRIVATE-IC');
        expect(await withTenant(tech, tx => tx.select().from(schema.lcOnboardingPrivate))).toHaveLength(0);
        expect((await onboardingDetail(admin, row.case.id)).case.source.ic).toBe('PRIVATE-IC');
        const publicRows = await owner.db.select().from(schema.lcOnboardingCase);
        expect(JSON.stringify(publicRows)).not.toContain('PRIVATE-IC');
        expect(JSON.stringify(await owner.db.select().from(schema.lcOnboardingCaseRevision))).not.toContain('PRIVATE-IC');
        expect(await withTenant(tech, tx => tx.select().from(schema.lcOnboardingPrivateRevision))).toHaveLength(0);
    });
    it('allows assigned staff without module access to act but denies full onboarding pages', async () => {
        const row = await prepared();
        await expect(onboardingDetail(tech, row.case.id)).rejects.toThrow('access');
        const queue = await onboardingTasks(tech);
        expect(queue.some(i => i.kind === 'checklist')).toBe(true);
        expect((await onboardingDetail(tech,row.case.id,'task')).availability).toEqual({});
        await onboardingCommand(tech, row.case.id, row.revision, { type: 'task', taskId: 'welcome', status: 'done' });
        expect((await onboardingDetail(admin, row.case.id)).case.tasks[0]!.status).toBe('done');
    });
    it('RLS hides an unrelated case and service actions refuse an unrelated user', async () => {
        const row = await prepared();
        expect(await withTenant(other, tx => tx.select().from(schema.lcOnboardingCase))).toHaveLength(0);
        await expect(onboardingDetail(other, row.case.id, 'task')).rejects.toThrow('not found');
        await expect(onboardingCommand(other, row.case.id, row.revision, { type: 'handover' })).rejects.toThrow();
    });
    it('serializes simultaneous claims and refuses a stale write or peer takeover', async () => {
        const context = await onboardingContext(admin), config = structuredClone(context.config);
        config.groups.find(g => g.id === 'group-tech')!.members.push(other.userId!);
        await onboardingSaveConfig(admin, context.revision, config);
        const row = await prepared(), item = row.case.requisitions[0]!.items[0]!;
        const results = await Promise.allSettled([tech, other].map(user => onboardingCommand(user, row.case.id, row.revision, { type: 'fulfil', itemId: item.id, status: 'progress' })));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
        const current = await onboardingDetail(admin, row.case.id);
        const claimed = current.case.requisitions[0]!.items[0]!;
        expect([tech.userId, other.userId]).toContain(claimed.claim);
        const peer = claimed.claim === tech.userId ? other : tech;
        await expect(onboardingCommand(peer, row.case.id, current.revision, { type: 'fulfil', itemId: item.id, status: 'done' })).rejects.toThrow();
        await expect(onboardingCommand(tech, row.case.id, row.revision, { type: 'fulfil', itemId: item.id, status: 'done' })).rejects.toThrow('changed');
    });
    it('keeps old task/requisition history after cancel, reopen and resubmit', async () => {
        let row = await prepared();
        const old = row.case.requisitions[0]!.number;
        await onboardingCommand(admin, row.case.id, row.revision, { type: 'cancel', reason: 'Candidate declined' });
        expect(await onboardingTasks(tech)).toHaveLength(0);
        row = (await onboardingList(admin))[0]!;
        await onboardingCommand(admin, row.case.id, row.revision, { type: 'reopen' });
        row = (await onboardingList(admin))[0]!;
        await onboardingCommand(admin, row.case.id, row.revision, { type: 'submit' });
        const result = (await onboardingDetail(admin, row.case.id)).case;
        expect(result.requisitions).toHaveLength(2);
        expect(result.requisitions[0]!.cancelledAt).toBeTruthy();
        expect(result.requisitions[1]!.number).not.toBe(old);
        expect(result.taskHistory).toHaveLength(1);
    });
    it('does not change or delete any legacy case on new-model cancellation', async () => {
        const legacy = await createOnboardingCase(admin, { companyId: b.companyId, fullName: 'Legacy Hire', employeeNo: 'OLD-1', joinDate: todayInKualaLumpur(), jobTitle: 'Analyst', department: 'Finance', supervisor: 'Boss', laptopRequired: true, carparkRequired: false });
        const history = await caseHistory(admin, 'onboarding', legacy.number);
        const row = await prepared();
        const before = await owner.db.select().from(schema.lcCase);
        expect(before).toHaveLength(1);
        await onboardingCommand(admin, row.case.id, row.revision, { type: 'cancel', reason: 'Withdrawn' });
        expect(await owner.db.select().from(schema.lcCase)).toEqual(before);
        expect(await caseHistory(admin, 'onboarding', legacy.number)).toEqual(history);
    });
    it('cancels submitted work on Personnel draft discard while preserving source UUID/history', async () => {
        const row = await prepared();
        await discardEmployeeDraft(admin, row.case.sourceDraftId!);
        const after = (await onboardingDetail(admin, row.case.id)).case;
        expect(after.state).toBe('cancelled');
        expect(after.sourceDraftId).toBe(row.case.sourceDraftId);
        expect(after.requisitions).toHaveLength(1);
    });
    it('validates module access changes separately from group membership', async () => {
        const row = await prepared(), ctx = await onboardingContext(admin), config = structuredClone(ctx.config);
        config.access.onboarding.push(tech.userId!);
        await onboardingSaveConfig(admin, ctx.revision, config);
        const next = await onboardingContext(tech);
        expect(next.actor.module).toBe(true);
        config.access.onboarding.push(other.userId!);
        await expect(onboardingSaveConfig(tech, next.revision, config)).rejects.toThrow('Master Admin');
    });
    it('tags, resolves on reply and stores login-based notification reads independently', async () => {
        const row = await prepared();
        await onboardingNote(admin, row.case.id, { context: 'requisition', body: 'Please confirm', mentions: [tech.userId!] });
        expect((await onboardingTasks(tech)).some(x => x.kind === 'mention')).toBe(true);
        await onboardingNote(tech, row.case.id, { context: 'requisition', body: 'Confirmed', mentions: [] });
        expect((await onboardingTasks(tech)).some(x => x.kind === 'mention')).toBe(false);
        await sweepOnboarding(admin);
        const notices = await onboardingNotices(admin);
        expect(notices.length).toBeGreaterThan(0);
        await onboardingReadNotice(admin);
        expect(await onboardingNotices(admin)).toHaveLength(0);
    });
    it('retains note bodies through edits and deletion', async () => {
        const row = await prepared();
        await onboardingNote(admin, row.case.id, { context: 'requisition', body: 'First version', mentions: [] });
        const [note] = await owner.db.select().from(schema.lcOnboardingNote);
        await onboardingNote(admin, row.case.id, { id: note!.id, context: 'requisition', body: 'Second version', mentions: [] });
        await onboardingNote(admin, row.case.id, { id: note!.id, context: 'requisition', body: '', mentions: [], deleted: true });
        const [after] = await owner.db.select().from(schema.lcOnboardingNote);
        expect(after!.data).toMatchObject({ body: 'Second version', deleted: true, revisions: [{ body: 'First version' }, { body: 'Second version' }] });
    });
    it('a mention grants the scoped conversation without granting full requisition access', async () => {
        const row = await prepared();
        await onboardingNote(admin, row.case.id, { context: 'requisition', body: 'Please reply', mentions: [other.userId!] });
        const detail = await onboardingDetail(other, row.case.id, 'task');
        expect(detail.canOpenRequisition).toBe(false);
        expect(detail.case.source.email).toBeUndefined();
        expect(detail.case.requisitions[0]!.items).toHaveLength(0);
        expect(detail.notes.some(n => n.body === 'Please reply')).toBe(true);
        await expect(onboardingDetail(other, row.case.id, 'requisition')).rejects.toThrow('Requisition access');
        expect(await onboardingRequisitions(other)).toHaveLength(0);
        await onboardingNote(other, row.case.id, { context: 'requisition', body: 'Replied without page access', mentions: [] });
        expect((await onboardingTasks(other)).some(t => t.kind === 'mention')).toBe(false);
    });
    it('prevents a nonauthor from editing note content even through direct SQL', async () => {
        const row = await prepared();
        await onboardingNote(admin, row.case.id, { context: 'requisition', body: 'Original', mentions: [tech.userId!] });
        const [n] = await owner.db.select().from(schema.lcOnboardingNote);
        await expect(withTenant(tech, tx => tx.execute(sql `update lc_onboarding_note set data=jsonb_set(data,'{body}','"Changed"') where id=${n!.id}::uuid`))).rejects.toThrow();
    });
});
