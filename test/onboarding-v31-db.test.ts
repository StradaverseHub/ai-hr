import {randomUUID} from 'node:crypto';
import { afterAll, beforeEach, describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { saveEmployeeDraft, discardEmployeeDraft, completeEmployeeDraft } from '../core/employee-draft';
import { hireEmployee } from '../core/org';
import { v9OwnTask, onboardingSetup, onboardingContext, onboardingList, onboardingDetail, onboardingCommand, onboardingSaveConfig, onboardingSaveChecklistTasks, onboardingTasks, onboardingBoundedTask, onboardingAssignedTaskMetadata, onboardingNote, sweepOnboarding, onboardingNotices, onboardingReadNotice, createOnboardingCase, caseHistory, refreshOnboardingPersonnel, onboardingSyncDraftTx, onboardingRequisitions, onboardingNavigation } from '../packs/lifecycle/service';
import { appendEvent, actorOf } from '../db/events';
import { closeAll, resetDb, seedBase, setModule, entitledCtx, owner, createAppUser, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';
import { dayDate,decide as canonicalDecide,assignApproval as canonicalAssignApproval } from '../lib/onboarding-model';
import { onboardingConfigSchema } from '../lib/onboarding-validation';
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
    async function masterWithoutOnboarding() {
        const before = await onboardingContext(admin), config = structuredClone(before.config);
        // Keep another existing member and two ordered steps to exercise actual scope and ordering.
        config.access.onboarding = [tech.userId!];
        config.workflows[0]!.steps.push({ id: 'second-approval', label: 'Second approval', type: 'group', target: 'people-gbs', method: 'rr' });
        await onboardingSaveConfig(admin, before.revision, config);
        const current = await onboardingContext(admin);
        expect(current.actor).toMatchObject({ master: true, module: false });
        return current;
    }
    it('allows a first access-only grant after a real jsonb roundtrip without changing cases or other memberships', async () => {
        await draft();
        const before = await masterWithoutOnboarding(), input = structuredClone(before.config);
        const retainedCases = await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.tenantId, b.tenantId)).orderBy(schema.lcOnboardingCase.id);
        const retainedHistory = await owner.db.select().from(schema.lcOnboardingCaseRevision).where(eq(schema.lcOnboardingCaseRevision.tenantId, b.tenantId)).orderBy(schema.lcOnboardingCaseRevision.caseId, schema.lcOnboardingCaseRevision.revision);
        expect(retainedCases).toHaveLength(1);
        input.access.onboarding.push(admin.userId!);
        // The database reader returns jsonb key order; Zod reconstructs the declared schema order.
        // These are equal settings, but the old serialized-text guard rejects this exact pair.
        const parsed = onboardingConfigSchema.parse(input);
        const allowed = { ...before.config, groups: parsed.groups, access: parsed.access };
        expect(allowed).toEqual(parsed);
        expect(JSON.stringify(allowed)).not.toBe(JSON.stringify(parsed));
        await expect(onboardingSaveConfig(admin, before.revision - 1, input)).rejects.toThrow('Settings changed.');
        await onboardingSaveConfig(admin, before.revision, input);
        const after = await onboardingContext(admin);
        expect(after.revision).toBe(before.revision + 1);
        expect(after.actor).toMatchObject({ master: true, module: true });
        expect(after.config).toEqual({ ...before.config, access: { ...before.config.access, onboarding: [tech.userId!, admin.userId!] } });
        expect(after.config.access.offboarding).toEqual(before.config.access.offboarding);
        expect(after.config.groups).toEqual(before.config.groups);
        expect(await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.tenantId, b.tenantId)).orderBy(schema.lcOnboardingCase.id)).toEqual(retainedCases);
        expect(await owner.db.select().from(schema.lcOnboardingCaseRevision).where(eq(schema.lcOnboardingCaseRevision.tenantId, b.tenantId)).orderBy(schema.lcOnboardingCaseRevision.caseId, schema.lcOnboardingCaseRevision.revision)).toEqual(retainedHistory);
    });
    it('still rejects non-access settings and ordered-step changes before first access, and refuses non-master access grants', async () => {
        const before = await masterWithoutOnboarding();
        for (const change of [
            (config: typeof before.config) => { config.countEquipment = !config.countEquipment; },
            (config: typeof before.config) => { config.exceptions.remindDays += 1; },
            (config: typeof before.config) => { config.checklists[0]!.tasks[0]!.name = 'Unauthorized task edit'; },
            (config: typeof before.config) => { config.workflows[0]!.steps.reverse(); },
        ]) {
            const input = structuredClone(before.config); input.access.onboarding.push(admin.userId!); change(input);
            await expect(onboardingSaveConfig(admin, before.revision, input)).rejects.toThrow('Grant yourself Onboarding access before editing its settings.');
        }
        const forbidden = structuredClone(before.config); forbidden.access.onboarding.push(other.userId!);
        await expect(onboardingSaveConfig(tech, before.revision, forbidden)).rejects.toThrow('Only the Master Admin changes module access.');
        await expect(onboardingSaveConfig(other, before.revision, forbidden)).rejects.toThrow('Onboarding access is required.');
        const after = await onboardingContext(admin);
        expect(after.revision).toBe(before.revision); expect(after.config).toEqual(before.config);
        expect(after.actor).toMatchObject({ master: true, module: false });
    });
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
        await expect(sweepOnboarding(system)).rejects.toThrow('Scheduled onboarding dispatch requires the storage owner.');
        expect((await sweepOnboarding(system,owner.withTenant)).created).toBeGreaterThan(0);
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
    it('projects and completes only an actual assigned task outside general data scope, with a required native audit',async()=>{
        const context=await onboardingContext(admin),config=structuredClone(context.config);
        config.groups.push({id:'private-sibling-team',name:'Fictional sibling team',limit:8,members:[other.userId!]});
        config.checklists[0]!.tasks.push({id:'sibling',name:'PRIVATE other assigned checklist',by:'group',group:'private-sibling-team',method:'rr',opens:null,due:1,gate:false});
        await onboardingSaveConfig(admin,context.revision,config);
        const saved=await saveEmployeeDraft(admin,{data:{profile:{fullName:'Fictional hidden task subject',employeeCode:'HIDDEN-TASK-SUBJECT',primaryEmail:'hidden-task-subject@fixture.invalid'},employment:{companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:todayInKualaLumpur()},payroll:{basicSalary:'5000'}},currentStep:5});
        const active=await completeEmployeeDraft(admin,saved.id);let row=(await onboardingList(admin))[0]!;
        await onboardingCommand(admin,row.case.id,row.revision,{type:'saveSubmit',patch:{hiring:'new_hire',local:{supervisor:'Manager'},selected:['m365']}});row=(await onboardingList(admin))[0]!;
        for(const actor of [tech,other]){
            const id=randomUUID(),revision=randomUUID();await owner.client`insert into data_permission_profile(id,tenant_id,name)values(${id},${b.tenantId},${'Checklist scope '+id})`;
            await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by)values(${revision},${b.tenantId},${id},${JSON.stringify({legacyCompany:false,predicates:[{field:'employeeId',values:['ONLY-OWN-SELF-COURSE']}]})}::text::jsonb,${admin.userId!})`;
            await owner.client`update data_permission_profile set enabled=true,active_revision_id=${revision} where id=${id}`;
            await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by)values(${b.tenantId},${actor.userId!},${id},${admin.userId!})`;
        }
        expect(await withTenant(tech,tx=>tx.select().from(schema.employment).where(eq(schema.employment.id,active.employmentId)))).toEqual([]);
        expect(await withTenant(tech,tx=>tx.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id)))).toEqual([]);
        const queue=await onboardingTasks(tech);expect(queue.filter(task=>task.kind==='checklist').map(task=>task.taskId)).toEqual(['welcome']);expect(JSON.stringify(queue)).not.toContain('PRIVATE other assigned checklist');
        expect((await onboardingAssignedTaskMetadata(tech)).map(task=>task.id)).toContain(row.case.id+':checklist:welcome');
        await expect(onboardingCommand(other,row.case.id,row.revision,{type:'task',taskId:'welcome',status:'done'})).rejects.toThrow();
        await expect(withTenant(tech,tx=>tx.execute(sql`select * from app.onboarding_assigned_task_update(${row.case.id}::uuid,${row.revision},'welcome','done')`))).rejects.toThrow();
        expect((await onboardingList(admin))[0]!.revision).toBe(row.revision);
        await v9OwnTask(tech,{caseId:row.case.id,revision:row.revision,taskId:'welcome',status:'done',reason:''});
        const updated=(await onboardingList(admin))[0]!;expect(updated.case.tasks.find(task=>task.id==='welcome')).toMatchObject({status:'done',completedBy:tech.userId});
        expect(updated.case.tasks.find(task=>task.id==='sibling')?.status).toBe('todo');
        expect((await onboardingTasks(tech)).some(task=>task.taskId==='welcome')).toBe(false);
        expect((await owner.client`select count(*)::int as count from app.lifecycle_native_effect_context`)[0].count).toBe(0);
    });
    it('retains eligible workflow IDs while masking names excluded by a data profile',async()=>{
        const id=randomUUID(),revision=randomUUID();
        await owner.client`insert into data_permission_profile(id,tenant_id,name)values(${id},${b.tenantId},${'Directory scope '+id})`;
        await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by)values(${revision},${b.tenantId},${id},${JSON.stringify({legacyCompany:false,predicates:[{field:'employeeId',values:['ABSENT-DIRECTORY-SUBJECT']}]})}::text::jsonb,${admin.userId!})`;
        await owner.client`update data_permission_profile set enabled=true,active_revision_id=${revision} where id=${id}`;
        await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by)values(${b.tenantId},${tech.userId!},${id},${admin.userId!})`;
        const directory=await withTenant(tech,tx=>tx.execute(sql`select * from app.onboarding_directory()`)) as unknown as {id:string;name:string}[];
        expect(directory.find(user=>user.id===other.userId)?.name).toBe('User '+other.userId!.slice(0,8));
        expect(directory.some(user=>user.name==='Other Employee')).toBe(false);
        expect(directory.find(user=>user.id===tech.userId)?.name).toBe('Kevin Tech');
        await owner.client`update app_user set archived_at=now() where id=${other.userId!}`;
        expect((await withTenant(tech,tx=>tx.execute(sql`select * from app.onboarding_directory()`)) as unknown as {id:string}[]).some(user=>user.id===other.userId)).toBe(false);
    });
    it('fences prospective joiner children using canonical Personnel facts and keeps hidden tasks bounded',async()=>{
        const row=await prepared(),caseId=row.case.id,scopeId=randomUUID(),scopeRevision=randomUUID(),noteId=randomUUID(),fileId=randomUUID();
        await owner.client`insert into lc_onboarding_private_revision(case_id,revision,tenant_id,company_id,data)values(${caseId},900,${b.tenantId},${b.companyId},${JSON.stringify({ic:'PRIVATE-HISTORY-IC'})}::text::jsonb)`;
        await owner.client`insert into lc_onboarding_note(id,tenant_id,case_id,data)values(${noteId},${b.tenantId},${caseId},${JSON.stringify({by:admin.userId,text:'PRIVATE-NOTE',mentions:[]})}::text::jsonb)`;
        await owner.client`insert into lc_v9_file(id,tenant_id,onboarding_case_id,company_id,slot,filename,mime_type,content,uploaded_by)values(${fileId},${b.tenantId},${caseId},${b.companyId},'private','PRIVATE-FILE.txt','text/plain',decode('50524956415445','hex'),${admin.userId!})`;
        const read=()=>withTenant(admin,async tx=>({
            parent:await tx.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,caseId)),
            private:await tx.select().from(schema.lcOnboardingPrivate).where(eq(schema.lcOnboardingPrivate.caseId,caseId)),
            history:await tx.select().from(schema.lcOnboardingCaseRevision).where(eq(schema.lcOnboardingCaseRevision.caseId,caseId)),
            privateHistory:await tx.select().from(schema.lcOnboardingPrivateRevision).where(eq(schema.lcOnboardingPrivateRevision.caseId,caseId)),
            notes:await tx.select().from(schema.lcOnboardingNote).where(eq(schema.lcOnboardingNote.caseId,caseId)),
            files:await tx.execute(sql`select id,filename from lc_v9_file where onboarding_case_id=${caseId}::uuid order by id`),
        }));
        const baseline=await read();for(const rows of Object.values(baseline))expect(rows.length).toBeGreaterThan(0);
        await owner.client`insert into data_permission_profile(id,tenant_id,name)values(${scopeId},${b.tenantId},${'Prospective scope '+scopeId})`;
        const excluded={legacyCompany:false,predicates:[{field:'department',values:[randomUUID()]}]};
        await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by)values(${scopeRevision},${b.tenantId},${scopeId},${JSON.stringify(excluded)}::text::jsonb,${admin.userId!})`;
        await owner.client`update data_permission_profile set enabled=true,active_revision_id=${scopeRevision} where id=${scopeId}`;
        await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by)values(${b.tenantId},${admin.userId!},${scopeId},${admin.userId!})`;
        for(const rows of Object.values(await read()))expect(rows).toEqual([]);
        // Changing editable workflow facts cannot manufacture a matching Personnel source.
        await owner.client`update lc_onboarding_case set data=jsonb_set(data,'{local,department}',to_jsonb(${excluded.predicates[0]!.values[0]!}::text),true)where id=${caseId}`;
        for(const rows of Object.values(await read()))expect(rows).toEqual([]);
        const matching=randomUUID();await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by)values(${matching},${b.tenantId},${scopeId},${JSON.stringify({legacyCompany:false,predicates:[{field:'company',values:[b.companyId]},{field:'department',values:[b.deptA]}]})}::text::jsonb,${admin.userId!})`;
        await owner.client`update data_permission_profile set active_revision_id=${matching} where id=${scopeId}`;
        for(const rows of Object.values(await read()))expect(rows.length).toBeGreaterThan(0);
        await owner.client`update data_permission_profile set enabled=false where id=${scopeId}`;
        for(const rows of Object.values(await read()))expect(rows).toEqual([]);
    });
    it('retains native completion audit witnesses across a real savepoint',async()=>{
        const row=await prepared();expect(row.case.tasks.find(task=>task.id==='welcome')?.assignee).toBe(tech.userId);
        await withTenant(tech,async tx=>{
            await tx.execute(sql`savepoint assigned_task_effect`);
            await tx.execute(sql`select * from app.onboarding_assigned_task_update(${row.case.id}::uuid,${row.revision},'welcome','progress')`);
            await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'onboarding-case',aggregateId:row.case.id,eventType:'onboarding.task',actor:actorOf(tech),subjectEmploymentId:row.case.employmentId,payload:{caseId:row.case.id,companyId:b.companyId}});
            await tx.execute(sql`release savepoint assigned_task_effect`);
            await tx.execute(sql`set constraints all immediate`);
        });
        const updated=(await onboardingList(admin))[0]!;expect(updated.revision).toBe(row.revision+1);expect(updated.case.tasks.find(task=>task.id==='welcome')?.status).toBe('progress');
        await v9OwnTask(tech,{caseId:updated.case.id,revision:updated.revision,taskId:'welcome',status:'done',reason:''});
        expect((await onboardingList(admin))[0]!.case.tasks.find(task=>task.id==='welcome')?.status).toBe('done');
    });
    it('records only native handover and note effects for a hidden assigned team',async()=>{
        let row=await prepared();
        const id=randomUUID(),revision=randomUUID();await owner.client`insert into data_permission_profile(id,tenant_id,name)values(${id},${b.tenantId},${'Delivery scope '+id})`;
        await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by)values(${revision},${b.tenantId},${id},${JSON.stringify({legacyCompany:false,predicates:[{field:'department',values:[randomUUID()]}]})}::text::jsonb,${admin.userId!})`;
        await owner.client`update data_permission_profile set enabled=true,active_revision_id=${revision} where id=${id}`;
        await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by)values(${b.tenantId},${tech.userId!},${id},${admin.userId!})`;
        expect(await withTenant(tech,tx=>tx.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id)))).toEqual([]);
        const deliveryQueue=await onboardingTasks(tech),teamTask=deliveryQueue.find(task=>task.kind==='team'&&task.caseId===row.case.id)!;
        expect(teamTask).toMatchObject({bounded:true,itemIds:[row.case.requisitions[0]!.items[0]!.id]});
        expect((await onboardingBoundedTask(tech,teamTask.id)).task.id).toBe(teamTask.id);
        await expect(onboardingBoundedTask(other,teamTask.id)).rejects.toThrow();
        const itemId=row.case.requisitions[0]!.items[0]!.id;
        await expect(onboardingCommand(other,row.case.id,row.revision,{type:'fulfil',itemId,status:'done'})).rejects.toThrow();
        await expect(withTenant(tech,tx=>tx.execute(sql`select * from app.onboarding_fulfil_item(${row.case.id}::uuid,${row.revision},${itemId},'done')`))).rejects.toThrow();
        expect((await onboardingList(admin))[0]!.revision).toBe(row.revision);
        await onboardingCommand(tech,row.case.id,row.revision,{type:'fulfil',itemId,status:'done'});row=(await onboardingList(admin))[0]!;
        expect(row.case.requisitions[0]!.items[0]!.state).toBe('ready');
        expect((await onboardingTasks(tech)).some(task=>task.id===teamTask.id)).toBe(false);
        expect((await onboardingTasks(tech)).find(task=>task.kind==='handover'&&task.caseId===row.case.id)?.bounded).toBe(true);
        await expect(onboardingCommand(other,row.case.id,row.revision,{type:'readNote'})).rejects.toThrow();
        await expect(withTenant(tech,tx=>tx.execute(sql`select * from app.onboarding_delivery_update(${row.case.id}::uuid,${row.revision},'readNote','{}'::jsonb)`))).rejects.toThrow();
        expect((await onboardingList(admin))[0]!.revision).toBe(row.revision);
        const before=structuredClone(row.case);await onboardingCommand(tech,row.case.id,row.revision,{type:'readNote'});
        row=(await onboardingList(admin))[0]!;
        expect(row.case.requisitions[0]!.noteAcks[tech.userId!]).toBe(row.case.requisitions[0]!.noteVersion);
        expect(row.case.tasks).toEqual(before.tasks);expect(row.case.source).toEqual(before.source);expect(row.case.local).toEqual(before.local);
        await onboardingCommand(tech,row.case.id,row.revision,{type:'handover'});row=(await onboardingList(admin))[0]!;
        expect(row.case.requisitions[0]!.handedAt).toBeTruthy();expect(row.case.requisitions[0]!.items[0]!.state).toBe('handed');
        const retained=row.revision;await onboardingCommand(tech,row.case.id,retained-1,{type:'handover'});expect((await onboardingList(admin))[0]!.revision).toBe(retained);
        await owner.client`update lc_onboarding_config set data=jsonb_set(data,'{groups}',(select jsonb_agg(case when g->>'id'='group-tech' then jsonb_set(g,'{members}','[]'::jsonb)else g end)from jsonb_array_elements(data->'groups')g))where tenant_id=${b.tenantId}`;
        await expect(onboardingCommand(tech,row.case.id,row.revision,{type:'readNote'})).rejects.toThrow();
    });
    it('keeps a hidden assigned conversation finite through author edit mention resolution and denial',async()=>{
        const row=await prepared();
        for(const actor of[tech,other]){
            const id=randomUUID(),revision=randomUUID();await owner.client`insert into data_permission_profile(id,tenant_id,name)values(${id},${b.tenantId},${'Conversation scope '+id})`;
            await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by)values(${revision},${b.tenantId},${id},${JSON.stringify({legacyCompany:false,predicates:[{field:'department',values:[randomUUID()]}]})}::text::jsonb,${admin.userId!})`;
            await owner.client`update data_permission_profile set enabled=true,active_revision_id=${revision} where id=${id}`;
            await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by)values(${b.tenantId},${actor.userId!},${id},${admin.userId!})`;
        }
        const projection=(actor:SessionContext,context='welcome')=>withTenant(actor,tx=>tx.execute<{note:import('../lib/onboarding-model').Note}>(sql`select app.onboarding_conversation_rows(${row.case.id}::uuid,${context}) as note`));
        await expect(onboardingNote(other,row.case.id,{context:'welcome',body:'UNASSIGNED',mentions:[]})).rejects.toThrow();
        await expect(withTenant(tech,tx=>tx.execute(sql`select * from app.onboarding_conversation_update(${row.case.id}::uuid,'welcome',null,'NO-AUDIT','[]'::jsonb,false,false)`))).rejects.toThrow();
        expect(await projection(tech)).toEqual([]);
        await onboardingNote(tech,row.case.id,{context:'welcome',body:'Assigned conversation',mentions:[other.userId!]});
        expect(await withTenant(tech,tx=>tx.select().from(schema.lcOnboardingNote).where(eq(schema.lcOnboardingNote.caseId,row.case.id)))).toEqual([]);
        let notes=await projection(tech);expect(notes.map(n=>n.note.body)).toEqual(['Assigned conversation']);const note=notes[0]!.note;
        expect((await projection(other)).map(n=>n.note.body)).toEqual(['Assigned conversation']);
        const mentioned=(await onboardingTasks(other)).find(task=>task.noteId===note.id)!;expect(mentioned).toMatchObject({bounded:true,kind:'mention'});
        expect((await onboardingBoundedTask(other,mentioned.id)).notes.map(n=>n.body)).toEqual(['Assigned conversation']);
        expect((await onboardingAssignedTaskMetadata(other)).some(task=>task.id===mentioned.id)).toBe(true);
        await expect(onboardingNote(other,row.case.id,{id:note.id,context:'welcome',body:'OTHER-AUTHOR',mentions:[]})).rejects.toThrow('Only the author');
        await onboardingNote(other,row.case.id,{id:note.id,context:'welcome',body:'',mentions:[],resolve:true});
        expect((await projection(other))[0]!.note.resolved).toContain(other.userId);
        await onboardingNote(tech,row.case.id,{id:note.id,context:'welcome',body:'Edited assigned conversation',mentions:[other.userId!]});
        notes=await projection(tech);expect(notes[0]!.note.revisions?.[0]?.body).toBe('Assigned conversation');expect(notes[0]!.note.body).toBe('Edited assigned conversation');
        expect(await projection(tech,'case')).toEqual([]);
        await expect(onboardingNote(tech,row.case.id,{id:note.id,context:'case',body:'CONTEXT-SMUGGLE',mentions:[]})).rejects.toThrow();
        expect((await projection(tech))[0]!.note.body).toBe('Edited assigned conversation');
        expect((await owner.client`select count(*)::int as n from app.lifecycle_native_effect_context`)[0].n).toBe(0);
    });
    it('decides exact hidden assigned approvals with canonical requester auto-approval and no sibling rewrite',async()=>{
        const context=await onboardingContext(admin),config=structuredClone(context.config);config.catalogue[0]!.workflow='standard';
        config.workflows[0]!.steps.push({id:'requester-confirmation',label:'Requester confirmation',type:'person',target:admin.userId!,method:'rr'});
        await onboardingSaveConfig(admin,context.revision,config);const row=await prepared(),item=row.case.requisitions[0]!.items[0]!;
        expect(item.approval).toBe('pending');expect(item.steps[0]!.user).toBe(tech.userId);
        const id=randomUUID(),revision=randomUUID();await owner.client`insert into data_permission_profile(id,tenant_id,name)values(${id},${b.tenantId},${'Approval scope '+id})`;
        await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by)values(${revision},${b.tenantId},${id},${JSON.stringify({legacyCompany:false,predicates:[{field:'department',values:[randomUUID()]}]})}::text::jsonb,${admin.userId!})`;
        await owner.client`update data_permission_profile set enabled=true,active_revision_id=${revision} where id=${id}`;
        await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by)values(${b.tenantId},${tech.userId!},${id},${admin.userId!})`;
        expect(await withTenant(tech,tx=>tx.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id)))).toEqual([]);
        const task=(await onboardingTasks(tech)).find(task=>task.kind==='approval'&&task.caseId===row.case.id)!;expect(task).toMatchObject({bounded:true,itemIds:[item.id]});
        const review=await onboardingBoundedTask(tech,task.id);expect(review.items).toEqual([{id:item.id,name:item.name}]);expect(JSON.stringify(review)).not.toContain('PRIVATE-IC');
        await expect(onboardingCommand(other,row.case.id,row.revision,{type:'approve',itemIds:[item.id],decision:'approve'})).rejects.toThrow();
        await expect(onboardingCommand(tech,row.case.id,row.revision,{type:'approve',itemIds:[item.id,item.id],decision:'approve'})).rejects.toThrow('only once');
        await expect(withTenant(tech,tx=>tx.execute(sql`select * from app.onboarding_approval_decide(${row.case.id}::uuid,${row.revision},${JSON.stringify([item.id])}::jsonb,'approve')`))).rejects.toThrow();
        expect((await onboardingList(admin))[0]!.revision).toBe(row.revision);
        const expected=structuredClone(row.case);canonicalDecide(config,expected,[item.id],'approve',{id:tech.userId!,name:'Kevin Tech',master:false,hr:false,module:false},{now:'2026-11-02T00:00:00.000Z',today:todayInKualaLumpur(),id:randomUUID,nextNumber:()=>'',leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:[tech.userId!,admin.userId!],userNames:{[admin.userId!]:item.requesterName??'User'}});
        await onboardingCommand(tech,row.case.id,row.revision,{type:'approve',itemIds:[item.id],decision:'approve'});
        const updated=(await onboardingList(admin))[0]!.case,actual=updated.requisitions[0]!.items[0]!,wanted=expected.requisitions[0]!.items[0]!;
        const decisions=(entry:typeof item)=>entry.steps.map(({when,...step})=>step);expect(decisions(actual)).toEqual(decisions(wanted));expect(actual.approval).toBe('approved');
        expect(updated.tasks).toEqual(expected.tasks);expect(updated.source).toEqual(expected.source);expect(updated.local).toEqual(expected.local);
        const history=(c:typeof expected)=>c.history.slice(row.case.history.length).map(({id,at,...entry})=>entry);expect(history(updated)).toEqual(history(expected));
        expect((await onboardingTasks(tech)).some(task=>task.id===review.task.id)).toBe(false);
    });
    it('assigns only the actual pending approval group across its recorded siblings under hidden data scope',async()=>{
        const context=await onboardingContext(admin),config=structuredClone(context.config);config.workflows[0]!.steps[0]!.method='manual';config.catalogue[0]!.workflow='standard';config.catalogue.push({...config.catalogue[0]!,id:'vpn',name:'Fictional VPN'});config.groups.find(group=>group.id==='tech-bp')!.members=[tech.userId!,admin.userId!];
        await onboardingSaveConfig(admin,context.revision,config);await draft();let row=(await onboardingList(admin))[0]!;
        await onboardingCommand(admin,row.case.id,row.revision,{type:'saveSubmit',patch:{hiring:'new_hire',local:{supervisor:'Manager'},selected:['m365','vpn']}});row=(await onboardingList(admin))[0]!;const item=row.case.requisitions[0]!.items[0]!,step=item.steps[0]!;
        expect(step).toMatchObject({manual:true,user:null,status:'pending'});
        const id=randomUUID(),revision=randomUUID();await owner.client`insert into data_permission_profile(id,tenant_id,name)values(${id},${b.tenantId},${'Manual approval scope '+id})`;
        await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by)values(${revision},${b.tenantId},${id},${JSON.stringify({legacyCompany:false,predicates:[{field:'department',values:[randomUUID()]}]})}::text::jsonb,${admin.userId!})`;
        await owner.client`update data_permission_profile set enabled=true,active_revision_id=${revision} where id=${id}`;
        await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by)values(${b.tenantId},${tech.userId!},${id},${admin.userId!})`;
        expect(await withTenant(tech,tx=>tx.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id)))).toEqual([]);
        const task=(await onboardingTasks(tech)).find(task=>task.kind==='manualApproval'&&task.caseId===row.case.id)!;expect(task).toMatchObject({bounded:true,stepId:step.id});
        const review=await onboardingBoundedTask(tech,task.id);expect(review.candidates?.map(candidate=>candidate.id)).toEqual([tech.userId,admin.userId]);expect(review.candidates?.find(candidate=>candidate.id===admin.userId)?.name).toBe('User '+admin.userId!.slice(0,8));
        await expect(onboardingCommand(other,row.case.id,row.revision,{type:'assignApproval',itemId:item.id,stepId:step.id,user:tech.userId!})).rejects.toThrow();
        await expect(onboardingCommand(tech,row.case.id,row.revision,{type:'assignApproval',itemId:item.id,stepId:step.id,user:other.userId!})).rejects.toThrow('member');
        await expect(withTenant(tech,tx=>tx.execute(sql`select * from app.onboarding_approval_assign(${row.case.id}::uuid,${row.revision},${item.id},${step.id},${tech.userId!})`))).rejects.toThrow();
        const expected=structuredClone(row.case);canonicalAssignApproval(config,expected,item.id,step.id,tech.userId!,{id:tech.userId!,name:'Kevin Tech',master:false,hr:false,module:false},{now:'2026-11-02T00:00:00.000Z',today:todayInKualaLumpur(),id:randomUUID,nextNumber:()=>'',leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:[tech.userId!,admin.userId!]});
        await onboardingCommand(tech,row.case.id,row.revision,{type:'assignApproval',itemId:item.id,stepId:step.id,user:tech.userId!});const actual=(await onboardingList(admin))[0]!.case;
        const selections=(c:typeof actual)=>c.requisitions[0]!.items.map(item=>item.steps.map(({when,assignments,...step})=>({...step,assignments:assignments.map(({at,...assignment})=>assignment)})));expect(selections(actual)).toEqual(selections(expected));expect(actual.tasks).toEqual(expected.tasks);
        expect((await onboardingTasks(tech)).some(task=>task.id===review.task.id)).toBe(false);
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
