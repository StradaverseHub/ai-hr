import {publishActionCapabilityPackage} from '../deploy/access/publish-workforce-capabilities';
import {randomUUID} from 'node:crypto';
import { afterAll, beforeEach, describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { saveEmployeeDraft, discardEmployeeDraft, completeEmployeeDraft, saveAndCompleteEmployeeDraft } from '../core/employee-draft';
import { hireEmployee } from '../core/org';
import { v9OwnTask, onboardingSetup, onboardingContext, onboardingList, onboardingDetail, onboardingCommand, onboardingSaveConfig, onboardingSaveChecklistTasks, onboardingTasks, onboardingBoundedTask, onboardingAssignedTaskMetadata, onboardingNote, sweepOnboarding, onboardingNotices, onboardingReadNotice, createOnboardingCase, caseHistory, refreshOnboardingPersonnel, onboardingSyncDraftTx, onboardingRequisitions, onboardingNavigation } from '../packs/lifecycle/service';
import { appendEvent, actorOf } from '../db/events';
import { closeAll, resetDb, seedBase, setModule, entitledCtx, owner, createAppUser, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';
import {pgErrorChain} from '../lib/db-error';
import { dayDate,decide as canonicalDecide,assignApproval as canonicalAssignApproval,cancelCase as canonicalCancelCase,addItem as canonicalAddItem,removeItem as canonicalRemoveItem } from '../lib/onboarding-model';
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
    it('publishes assigned checklist work and preserves View under Execute denial',async()=>{
        const row=await prepared(),cap='function.lifecycle.shared.tasks.execute';
        try{
            expect(await publishActionCapabilityPackage(owner.client,'lifecycle_assigned_tasks')).toMatchObject({changed:true,capabilities:2});
            expect(await publishActionCapabilityPackage(owner.client,'lifecycle_assigned_tasks')).toMatchObject({changed:false});
            const read=()=>onboardingTasks(tech).then(rows=>rows.find(task=>task.caseId===row.case.id&&task.taskId==='welcome'));
            expect(await read()).toBeDefined();
            await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
             values(${b.tenantId}::uuid,${tech.userId!}::uuid,${cap},${b.companyId}::uuid,'deny')`;
            expect(await read()).toBeDefined();
            const complete=()=>onboardingCommand(tech,row.case.id,row.revision,{type:'task',taskId:'welcome',status:'done'});
            await expect(complete()).rejects.toThrow();
            expect((await onboardingList(admin)).find(item=>item.case.id===row.case.id)?.revision).toBe(row.revision);
            await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid and capability_id=${cap}`;
            await complete();
            expect(await read()).toBeUndefined();
        }finally{
            await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid and capability_id=${cap}`;
            await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id like 'function.lifecycle.shared.tasks.%'`;
        }
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
    it('derives a saved Draft source without page authority, preserves private handling, and exposes no refresh receipt',async()=>{
        const before=await onboardingContext(admin),config=structuredClone(before.config);
        config.access.onboarding=[tech.userId!];
        config.access.joinerViewGroups=['group-tech'];
        config.access.joinerSections={'group-tech':{preset:'approver'}};
        config.groups.find(g=>g.id==='group-tech')!.members.push(admin.userId!);
        await onboardingSaveConfig(admin,before.revision,config);
        const saved=await saveEmployeeDraft(admin,{data:{profile:{fullName:'Source-only fictional hire',primaryEmail:'source-only@fixture.invalid',icNumber:'SOURCE-PRIVATE-IC'},employment:{companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,hiredOn:todayInKualaLumpur()}},currentStep:1});
        const [first]=await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.sourceDraftId,saved.id));
        expect(first).toBeDefined();
        expect(first!.data).toMatchObject({sourceDraftId:saved.id,personnelStatus:'Draft',state:'pending',source:{fullName:'Source-only fictional hire',company:b.companyId,department:b.deptA,title:b.positionId},history:[{action:'personnel.synced',by:admin.userId}]});
        expect(first!.data.source).not.toHaveProperty('ic');
        expect(await owner.db.select().from(schema.lcOnboardingPrivate).where(eq(schema.lcOnboardingPrivate.caseId,first!.id))).toEqual([]);
        expect(await withTenant(admin,tx=>tx.execute(sql`select * from app.onboarding_sync_saved_draft(${saved.id}::uuid)`))).toEqual([{handled:false,case_id:null,company_id:null,did_change:false}]);
        expect(await withTenant(other,tx=>tx.execute(sql`select * from app.onboarding_sync_saved_draft(${saved.id}::uuid)`))).toEqual([{handled:false,case_id:null,company_id:null,did_change:false}]);
        await saveEmployeeDraft(admin,{id:saved.id,data:{profile:{fullName:'Updated source-only hire',primaryEmail:'updated-source@fixture.invalid',icNumber:'UPDATED-PRIVATE-IC'},employment:{companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId}},currentStep:2});
        const [updated]=await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,first!.id));
        expect(updated!.data).toMatchObject({id:first!.id,number:first!.data.number,sourceDraftId:saved.id,source:{fullName:'Updated source-only hire',email:'updated-source@fixture.invalid'},tasks:[],requisitions:[]});
        expect(updated!.revision).toBe(first!.revision+1);
        const revisions=await owner.db.select().from(schema.lcOnboardingCaseRevision).where(eq(schema.lcOnboardingCaseRevision.caseId,first!.id));
        expect(revisions).toHaveLength(1);expect(revisions[0]!.data).toEqual(first!.data);
        expect(await owner.db.execute(sql`select id from app.lifecycle_native_effect_context where tenant_id=${b.tenantId}::uuid`)).toEqual([]);
    });
    it('closes a same-transaction SAVE image through actual activation and actual closed-port discard',async()=>{
        const active=await saveAndCompleteEmployeeDraft(admin,{data:{profile:{fullName:'Combined source activation',employeeCode:'SAVE-ACTIVE-NATIVE',primaryEmail:'save-active@fixture.invalid'},employment:{companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:todayInKualaLumpur()},payroll:{basicSalary:'5000'}},currentStep:5});
        const [activeCase]=await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.employmentId,active.employmentId));
        expect(activeCase!.data).toMatchObject({personnelStatus:'Active',employmentId:active.employmentId,source:{employeeId:'SAVE-ACTIVE-NATIVE'}});
        const discarded=await withTenant(admin,async tx=>{
            const saved=await saveEmployeeDraft(admin,{data:{profile:{fullName:'Combined source discard'},employment:{companyId:b.companyId}},currentStep:1},tx);
            await saveEmployeeDraft(admin,{id:saved.id,data:{profile:{fullName:'Second combined source discard'},employment:{companyId:b.companyId}},currentStep:2},tx);
            await discardEmployeeDraft(admin,saved.id,tx);return saved.id;
        });
        expect(await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id,discarded))).toEqual([]);
        const [cancelled]=await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.sourceDraftId,discarded));
        expect(cancelled!.data).toMatchObject({state:'cancelled',cancelReason:'Personnel draft discarded',sourceDraftId:discarded});
        expect(await owner.db.execute(sql`select id from app.lifecycle_native_effect_context where tenant_id=${b.tenantId}::uuid`)).toEqual([]);
    });
    it('invalidates a saved-source effect after same-transaction native authority revoke and restore',async()=>{
        const before=await onboardingContext(admin),input={profile:{fullName:'Revoked source fixture'},employment:{companyId:b.companyId}};
        await expect(withTenant(admin,async tx=>{
            await saveEmployeeDraft(admin,{data:input,currentStep:1},tx);
            const changed=structuredClone(before.config);changed.access.onboarding=[];
            await tx.update(schema.lcOnboardingConfig).set({data:changed}).where(eq(schema.lcOnboardingConfig.tenantId,b.tenantId));
            await tx.update(schema.lcOnboardingConfig).set({data:before.config}).where(eq(schema.lcOnboardingConfig.tenantId,b.tenantId));
        })).rejects.toThrow();
        expect((await owner.db.select().from(schema.employeeDraft)).filter(row=>row.label==='Revoked source fixture')).toEqual([]);
        const retried=await saveEmployeeDraft(admin,{data:input,currentStep:1});
        expect((await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.sourceDraftId,retried.id)))).toHaveLength(1);
    });
    it('derives DISCARD cancellation from the actual source and preserves native request and private history',async()=>{
        const context=await onboardingContext(admin),config=structuredClone(context.config);config.catalogue[0]!.workflow='standard';
        await onboardingSaveConfig(admin,context.revision,config);
        const row=await prepared(),[before]=await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id));
        const privateBefore=await owner.db.select().from(schema.lcOnboardingPrivate).where(eq(schema.lcOnboardingPrivate.caseId,row.case.id));
        const actor=(await onboardingContext(admin)).actor;
        expect(before!.data.requisitions[0]!.items[0]!.steps.some(step=>step.status==='pending')).toBe(true);
        await discardEmployeeDraft(admin,row.case.sourceDraftId!);
        const [after]=await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id));
        const entry=after!.data.history.at(-1)!,expected=structuredClone(before!.data);
        canonicalCancelCase(expected,'Personnel draft discarded',actor,{now:entry.at,today:todayInKualaLumpur(),id:()=>entry.id,nextNumber:()=>'',leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:[]});
        expect(after!.data).toEqual(expected);expect(after!.revision).toBe(before!.revision+1);
        expect(await owner.db.select().from(schema.lcOnboardingPrivate).where(eq(schema.lcOnboardingPrivate.caseId,row.case.id))).toEqual(privateBefore);
        const revisions=await owner.db.select().from(schema.lcOnboardingCaseRevision).where(eq(schema.lcOnboardingCaseRevision.caseId,row.case.id));
        expect(revisions.find(revision=>revision.revision===before!.revision)?.data).toEqual(before!.data);
        expect(await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id,row.case.sourceDraftId!))).toEqual([]);
    });
    it('refuses a DISCARD source cancellation without the actual native delete even when its onboarding audit exists',async()=>{
        const saved=await draft(),[before]=await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.sourceDraftId,saved.id));
        await expect(withTenant(admin,async tx=>{
            const [effect]=await tx.execute<{case_id:string;company_id:string;did_change:boolean}>(sql`select * from app.onboarding_sync_discarded_draft(${saved.id}::uuid)`);
            expect(effect).toMatchObject({case_id:before!.id,did_change:true});
            await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'onboarding-case',aggregateId:effect!.case_id,eventType:'onboarding.source_discarded',actor:actorOf(admin),payload:{caseId:effect!.case_id,companyId:effect!.company_id}});
        })).rejects.toThrow();
        expect(await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,before!.id))).toEqual([before]);
        expect(await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id,saved.id))).toHaveLength(1);
        await discardEmployeeDraft(admin,saved.id);
        expect(await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id,saved.id))).toEqual([]);
    });
    it('rolls a real saved-source effect back without its matching onboarding audit',async()=>{
        const id=randomUUID();
        await expect(withTenant(admin,async tx=>{
            await tx.insert(schema.employeeDraft).values({id,tenantId:b.tenantId,companyId:b.companyId,createdByPersonId:admin.personId,label:'Uncommitted source fixture',data:{profile:{fullName:'Uncommitted source fixture'},employment:{companyId:b.companyId}},currentStep:1});
            await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'employee-draft',aggregateId:id,eventType:'employee-draft.created',actor:actorOf(admin),payload:{companyId:b.companyId}});
            const [effect]=await tx.execute<{handled:boolean;did_change:boolean}>(sql`select * from app.onboarding_sync_saved_draft(${id}::uuid)`);
            expect(effect).toMatchObject({handled:true,did_change:true});
        })).rejects.toThrow();
        expect(await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id,id))).toEqual([]);
        expect(await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.sourceDraftId,id))).toEqual([]);
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
    it('adds an actual hidden exception with native routing fallback, shared approvers, requester approval and manual steps',async()=>{
        const unavailable=await hireEmployee(admin,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:dayDate(todayInKualaLumpur(),-30),person:{fullName:'Fictional subsequently unavailable reviewer',primaryEmail:'archived-exception-review@fixture.invalid'}}),unavailableUser=await createAppUser(b.tenantId,unavailable.personId,'employee');
        const context=await onboardingContext(admin),config=structuredClone(context.config);
        config.groups.push({id:'empty-routing',name:'Unavailable routing group',members:[],limit:0},{id:'fallback-routing',name:'Available routing group',members:[other.userId!],limit:0});
        config.routings.push({id:'exception-routing',name:'Exception routing',rows:[{id:'specific',rules:{company:[b.companyId]},group:'empty-routing'},{id:'fallback',rules:{},group:'fallback-routing'}]});
        config.workflows.push({id:'exception-native',name:'Native exception approval',mode:'par',steps:[{id:'requester',label:'Requester',type:'person',target:tech.userId!,method:'manual'},{id:'route-one',label:'First routed review',type:'routing',target:'exception-routing',method:'rr'},{id:'route-two',label:'Shared routed review',type:'routing',target:'exception-routing',method:'rr'},{id:'manual',label:'Manual facility review',type:'group',target:'facility',method:'manual'},{id:'missing-person',label:'Missing person review',type:'person',target:unavailableUser,method:'manual'}]});
        config.catalogue.push({id:'exception-native',name:'Fictional exception access',type:'system',active:true,rules:{},workflow:'exception-native',team:'group-tech',card:false});
        await onboardingSaveConfig(admin,context.revision,config);const row=await prepared();
        await owner.client`update app_user set archived_at=now()where id=${unavailableUser}::uuid`;
        const profile=randomUUID(),revision=randomUUID();await owner.client`insert into data_permission_profile(id,tenant_id,name)values(${profile},${b.tenantId},${'Exception scope '+profile})`;
        await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by)values(${revision},${b.tenantId},${profile},${JSON.stringify({legacyCompany:false,predicates:[{field:'department',values:[randomUUID()]}]})}::text::jsonb,${admin.userId!})`;
        await owner.client`update data_permission_profile set enabled=true,active_revision_id=${revision} where id=${profile}`;await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by)values(${b.tenantId},${tech.userId!},${profile},${admin.userId!})`;
        expect(await withTenant(tech,tx=>tx.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id)))).toEqual([]);
        const task=(await onboardingTasks(tech)).find(task=>task.caseId===row.case.id&&task.kind==='exceptionAdd')!;expect(task).toMatchObject({bounded:true,canExecute:true});
        const capability='function.lifecycle.shared.exceptionAdditions.execute';
        expect(await owner.withTenant(tech,tx=>tx.execute(sql`select (select capability_id from app.access_function_action where function_key='lifecycle.shared.exceptionAdditions'and operation='execute')as registered,app.lifecycle_exception_function_legacy_allowed(${b.tenantId}::uuid,${tech.userId!}::uuid,${capability},${b.companyId}::uuid)as pure,app.lifecycle_exception_function_current_legacy_allowed(${b.tenantId}::uuid,${tech.userId!}::uuid,${capability},${b.companyId}::uuid)as current,app.lifecycle_exception_function_legacy_allowed(${b.tenantId}::uuid,${tech.userId!}::uuid,'function.lifecycle.shared.exceptionAdditions.delete',${b.companyId}::uuid)as unsupported`))).toEqual([{registered:capability,pure:true,current:true,unsupported:false}]);
        expect(await owner.withTenant(admin,tx=>tx.execute(sql`select app.lifecycle_exception_function_legacy_allowed(${b.tenantId}::uuid,${tech.userId!}::uuid,${capability},${b.companyId}::uuid)as pure,app.lifecycle_exception_function_current_legacy_allowed(${b.tenantId}::uuid,${tech.userId!}::uuid,${capability},${b.companyId}::uuid)as current`))).toEqual([{pure:true,current:false}]);
        const review=await onboardingBoundedTask(tech,task.id);expect(review.catalogue?.map(item=>item.id)).toEqual(['exception-native']);expect(JSON.stringify(review)).not.toContain('PRIVATE-IC');expect(JSON.stringify(review)).not.toContain('Prepare welcome pack');
        await expect(onboardingBoundedTask(other,task.id)).rejects.toThrow();
        await expect(onboardingCommand(other,row.case.id,row.revision,{type:'addItem',catalogueId:'exception-native',reason:'Unauthorised',approval:true,confirmedBy:null})).rejects.toThrow();
        const command={type:'addItem' as const,catalogueId:'exception-native',reason:'Reviewed fictional exception 👩🏽‍💻 தமிழ்',approval:true,confirmedBy:other.userId!};
        await expect(withTenant(tech,tx=>tx.execute(sql`select * from app.onboarding_exception_update(${row.case.id}::uuid,${row.revision},'addItem',${JSON.stringify({catalogueId:command.catalogueId,reason:command.reason,approval:true,confirmedBy:other.userId!})}::jsonb)`))).rejects.toThrow();
        const [before]=await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id)),native=await onboardingContext(tech);
        const loads=await withTenant(tech,tx=>tx.execute<{user_id:string;pending_approvals:string;lifetime_approvals:string}>(sql`select * from app.onboarding_assignment_loads()`));
        await onboardingCommand(tech,row.case.id,row.revision,command);
        const [after]=await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id)),expected=structuredClone(before!.data),added=after!.data.requisitions[0]!.items.at(-1)!,events=after!.data.history.slice(before!.data.history.length),ids=[added.id,...events.map(event=>event.id)];
        canonicalAddItem(native.config,expected,expected.requisitions[0]!,native.config.catalogue.find(item=>item.id===command.catalogueId)!,'exception',false,command.reason,command.approval,command.confirmedBy,native.actor,{now:events[0]!.at,today:todayInKualaLumpur(),id:()=>ids.shift()!,nextNumber:()=>'',users:native.directory.map(user=>user.id),userNames:Object.fromEntries(native.directory.map(user=>[user.id,user.name])),leave:native.availability,taskLoads:native.loads,lastTaskAssignment:{},pendingApprovals:Object.fromEntries(loads.map(load=>[load.user_id,Number(load.pending_approvals)])),lifetimeApprovals:Object.fromEntries(loads.map(load=>[load.user_id,Number(load.lifetime_approvals)]))});
        expect((await owner.client`select app.onboarding_native_case_size(${JSON.stringify(after!.data)}::text::jsonb)::int as size`)[0].size).toBe(JSON.stringify(after!.data).length);
        expect(after!.data).toEqual(expected);expect(ids).toEqual([]);expect(added.steps.map(step=>[step.user,step.status,step.manual,step.viaDefault])).toEqual([[tech.userId,'approved',false,null],[other.userId,'pending',false,'Unavailable routing group'],[other.userId,'pending',false,'Unavailable routing group'],[null,'pending',true,null],[null,'unresolved',false,null]]);
        expect(added.confirmedByName).toBe('User '+other.userId!.slice(0,8));
        expect(await withTenant(tech,tx=>tx.select().from(schema.lcOnboardingPrivate).where(eq(schema.lcOnboardingPrivate.caseId,row.case.id)))).toEqual([]);
        await expect(onboardingCommand(tech,row.case.id,after!.revision,{type:'addItem',catalogueId:command.catalogueId,reason:'Duplicate',approval:false,confirmedBy:null})).rejects.toThrow('already requested');
        await expect(onboardingCommand(tech,row.case.id,after!.revision,{type:'removeItem',itemId:row.case.requisitions[0]!.items[0]!.id})).rejects.toThrow();
        const removeReview=(await onboardingTasks(tech)).find(task=>task.kind==='exceptionRemove'&&task.itemIds?.includes(added.id))!;expect((await onboardingBoundedTask(tech,removeReview.id)).items).toEqual([{id:added.id,name:added.name}]);
        const removedExpected=structuredClone(after!.data);canonicalRemoveItem(native.config,removedExpected,removedExpected.requisitions[0]!.items.at(-1)!,native.actor,{now:'REPLACED',today:todayInKualaLumpur(),id:()=> 'REPLACED',nextNumber:()=>'',users:[],leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{}});
        await onboardingCommand(tech,row.case.id,after!.revision,{type:'removeItem',itemId:added.id});const [removed]=await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id));removedExpected.history.at(-1)!.id=removed!.data.history.at(-1)!.id;removedExpected.history.at(-1)!.at=removed!.data.history.at(-1)!.at;
        expect(removed!.data).toEqual(removedExpected);expect((await onboardingTasks(tech)).some(task=>task.id===removeReview.id)).toBe(false);
    });
    it('publishes assigned exception courses and preserves the selected review under Additions Execute denial',async()=>{
        const context=await onboardingContext(admin),config=structuredClone(context.config);
        config.catalogue.push({id:'fictional-publication-exception',name:'Fictional exception',type:'system',active:true,
            rules:{},workflow:null,team:'group-tech',card:false});
        await onboardingSaveConfig(admin,context.revision,config);
        const row=await prepared(),cap='function.lifecycle.shared.exceptionAdditions.execute';
        try{
            expect(await publishActionCapabilityPackage(owner.client,'lifecycle_assigned_exceptions')).toMatchObject({changed:true,capabilities:6});
            expect(await publishActionCapabilityPackage(owner.client,'lifecycle_assigned_exceptions')).toMatchObject({changed:false});
            const read=()=>onboardingTasks(tech).then(rows=>rows.find(task=>task.kind==='exceptionAdd'&&task.caseId===row.case.id));
            expect(await read()).toBeDefined();
            await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
             values(${b.tenantId}::uuid,${tech.userId!}::uuid,${cap},${b.companyId}::uuid,'deny')`;
            expect(await read()).toMatchObject({canExecute:false});
            const add=()=>onboardingCommand(tech,row.case.id,row.revision,{type:'addItem',catalogueId:'fictional-publication-exception',
                reason:'Fictional publication check',approval:false,confirmedBy:null});
            await expect(add()).rejects.toThrow();
            expect((await onboardingList(admin)).find(item=>item.case.id===row.case.id)?.revision).toBe(row.revision);
            await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid and capability_id=${cap}`;
            await add();
            expect((await onboardingList(admin)).find(item=>item.case.id===row.case.id)?.revision).toBe(row.revision+1);
        }finally{
            await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid and capability_id=${cap}`;
            await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id like any(
             array['function.lifecycle.shared.exceptionAdditions.%','function.lifecycle.shared.exceptionRemovals.%','function.lifecycle.shared.retainedProvision.%'])`;
        }
    });
    it('uses the real V9 projection and actual workload limits for a newly added exception',async()=>{
        const row=await prepared();await(await import('../packs/lifecycle/service')).v9Setup(admin);
        const context=await onboardingContext(admin),config=structuredClone(context.config);config.groups.find(group=>group.id==='group-tech')!.members=[tech.userId!,other.userId!];config.groups.find(group=>group.id==='group-tech')!.limit=1;config.catalogue.push({id:'v9-exception',name:'Fictional V9 provision',type:'system',active:true,rules:{},workflow:null,team:'group-tech',card:false});await onboardingSaveConfig(admin,context.revision,config);
        const [before]=await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id)),native=await onboardingContext(tech);expect(native.config.v9ChecklistRevision).toBeGreaterThan(0);expect(native.loads[tech.userId!]).toBeGreaterThanOrEqual(1);
        await onboardingCommand(tech,row.case.id,before!.revision,{type:'addItem',catalogueId:'v9-exception',reason:'Actual V9 assignment',approval:false,confirmedBy:null});
        const [after]=await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id)),target=after!.data.requisitions[0]!.items.at(-1)!,events=after!.data.history.slice(before!.data.history.length),ids=[target.id,...events.map(event=>event.id)],expected=structuredClone(before!.data);
        canonicalAddItem(native.config,expected,expected.requisitions[0]!,native.config.catalogue.find(item=>item.id==='v9-exception')!,'exception',false,'Actual V9 assignment',false,null,native.actor,{now:events[0]!.at,today:todayInKualaLumpur(),id:()=>ids.shift()!,nextNumber:()=>'',users:native.directory.map(user=>user.id),userNames:Object.fromEntries(native.directory.map(user=>[user.id,user.name])),leave:native.availability,taskLoads:structuredClone(native.loads),lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{}});
        expect(after!.data).toEqual(expected);expect(ids).toEqual([]);expect(target).toMatchObject({fulfilmentMethod:'rr',dueDay:-1,claim:other.userId,assignmentFailure:null});expect(events.map(event=>event.action)).toEqual(['item.assigned','item.added']);
    });
    it('keeps only actual own or current team exception courses after group and profile changes',async()=>{
        const context=await onboardingContext(admin),config=structuredClone(context.config);config.groups.find(group=>group.id==='group-tech')!.members.push(other.userId!);config.catalogue.push({id:'own-exception',name:'Fictional retained access',type:'system',active:true,rules:{},workflow:null,team:'group-tech',card:false});
        await onboardingSaveConfig(admin,context.revision,config);const row=await prepared();await onboardingCommand(other,row.case.id,row.revision,{type:'addItem',catalogueId:'own-exception',reason:'Own approved source',approval:false,confirmedBy:null});
        let stored=(await onboardingList(admin))[0]!,item=stored.case.requisitions[0]!.items.at(-1)!;
        const current=await onboardingContext(admin),changed=structuredClone(current.config);changed.groups.find(group=>group.id==='group-tech')!.members=[tech.userId!];await onboardingSaveConfig(admin,current.revision,changed);
        const ownTask=(await onboardingTasks(other)).find(task=>task.kind==='exceptionRemove'&&task.itemIds?.includes(item.id))!;expect(ownTask).toMatchObject({assigned:true,bounded:true});
        expect(await withTenant(other,tx=>tx.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id)))).toEqual([]);
        const retired=await onboardingContext(admin),retiredConfig=structuredClone(retired.config);retiredConfig.catalogue.find(catalogue=>catalogue.id==='own-exception')!.active=false;await onboardingSaveConfig(admin,retired.revision,retiredConfig,{},true);
        stored=(await onboardingList(admin))[0]!;item=stored.case.requisitions[0]!.items.find(candidate=>candidate.id===item.id)!;expect(item.retiredFlag).toBe(true);
        const keep=(await onboardingTasks(tech)).find(task=>task.kind==='keepProviding'&&task.itemIds?.includes(item.id))!;expect((await onboardingBoundedTask(tech,keep.id)).items).toEqual([{id:item.id,name:item.name}]);
        await expect(onboardingCommand(other,stored.case.id,stored.revision,{type:'keepProviding',itemId:item.id})).rejects.toThrow();
        await onboardingCommand(tech,stored.case.id,stored.revision,{type:'keepProviding',itemId:item.id});stored=(await onboardingList(admin))[0]!;
        expect(stored.case.requisitions[0]!.items.find(candidate=>candidate.id===item.id)?.retiredFlag).toBe(false);expect(stored.case.history.at(-1)).toMatchObject({action:'item.kept',detail:item.name,by:tech.userId});
        await onboardingCommand(other,stored.case.id,stored.revision,{type:'removeItem',itemId:item.id});expect((await onboardingList(admin))[0]!.case.requisitions[0]!.items.find(candidate=>candidate.id===item.id)?.removed).toBe(true);
    });
    it('keeps the HR from-case removal course inside its actual data profile',async()=>{
        const before=await onboardingContext(admin),config=structuredClone(before.config);config.access.onboarding.push(tech.userId!);config.catalogue.push({id:'from-case-exception',name:'Fictional case extra',type:'system',active:true,rules:{},workflow:null,team:'group-tech',card:false},{id:'hr-positive-extra',name:'Fictional HR case extra',type:'system',active:true,rules:{},workflow:null,team:'group-tech',card:false});await onboardingSaveConfig(admin,before.revision,config);
        let row=await prepared();await onboardingCommand(tech,row.case.id,row.revision,{type:'save',patch:{extras:[{catalogueId:'from-case-exception',reason:'Actual case source',approval:false},{catalogueId:'hr-positive-extra',reason:'Actual HR source',approval:false}]}});row=(await onboardingList(admin))[0]!;const target=row.case.requisitions[0]!.items.find(item=>item.catalogueId==='from-case-exception')!;expect(target).toMatchObject({fromCase:true,addedBy:tech.userId});
        expect(await owner.withTenant(admin,tx=>tx.execute(sql`select app.access_function_delegation_floor('function.lifecycle.hr.exceptionRemovals.execute',${b.companyId}::uuid)as allowed`))).toEqual([{allowed:true}]);
        const positive=row.case.requisitions[0]!.items.find(item=>item.catalogueId==='hr-positive-extra')!,review=(await onboardingTasks(admin)).find(task=>task.kind==='exceptionRemove'&&task.itemIds?.includes(positive.id))!;expect((await onboardingBoundedTask(admin,review.id)).items).toEqual([{id:positive.id,name:positive.name}]);
        const edit='function.lifecycle.hr.exceptionRemovals.execute';
        const published=['lifecycle.view','lifecycle.edit','function.lifecycle.hr.exceptionRemovals.view',edit];
        try{
            expect(await publishActionCapabilityPackage(owner.client,'lifecycle_hr_removal')).toMatchObject({changed:true,capabilities:4});
            expect(await publishActionCapabilityPackage(owner.client,'lifecycle_hr_removal')).toMatchObject({changed:false});
            await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
                values(${b.tenantId}::uuid,${admin.userId!}::uuid,${edit},${b.companyId}::uuid,'deny')`;
            expect((await onboardingTasks(admin)).some(task=>task.kind==='exceptionRemove'&&task.itemIds?.includes(positive.id))).toBe(true);
            await expect(onboardingCommand(admin,row.case.id,row.revision,{type:'removeItem',itemId:positive.id})).rejects.toThrow();
            await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid
                and user_id=${admin.userId!}::uuid and capability_id=${edit}`;
            await expect(withTenant(admin,async tx=>{
                const [effect]=await tx.execute<{function_key:string;native_branch:string}>(sql`select * from app.onboarding_exception_update(${row.case.id}::uuid,${row.revision},'removeItem',${JSON.stringify({itemId:positive.id})}::jsonb)`);expect(effect).toMatchObject({function_key:'lifecycle.hr.exceptionRemovals',native_branch:'administrative-onboarding-exception-remove'});
                await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'onboarding-case',aggregateId:row.case.id,eventType:'onboarding.removeItem',actor:actorOf(admin),payload:{caseId:row.case.id,companyId:b.companyId,functionKey:'lifecycle.shared.exceptionRemovals',nativeBranch:'assigned-onboarding-exception-remove'}});
            })).rejects.toThrow();
            expect((await onboardingList(admin))[0]!.revision).toBe(row.revision);
            await onboardingCommand(admin,row.case.id,row.revision,{type:'removeItem',itemId:positive.id});row=(await onboardingList(admin))[0]!;expect(row.case.extras.map(item=>item.catalogueId)).toEqual(['from-case-exception']);
            const audit=await owner.client`select payload from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${row.case.id}::uuid and event_type='onboarding.removeItem'and payload->>'functionKey'='lifecycle.hr.exceptionRemovals'`;expect(audit).toHaveLength(1);expect(audit[0].payload).toMatchObject({functionKey:'lifecycle.hr.exceptionRemovals',nativeBranch:'administrative-onboarding-exception-remove'});
        }finally{
            await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id=any(${published}::text[])`;
            await owner.client`delete from app.access_native_capability_default where capability_id=any(${published}::text[])`;
        }
        const profile=randomUUID(),revision=randomUUID();await owner.client`insert into data_permission_profile(id,tenant_id,name)values(${profile},${b.tenantId},${'HR exception scope '+profile})`;
        await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by)values(${revision},${b.tenantId},${profile},${JSON.stringify({legacyCompany:false,predicates:[{field:'department',values:[randomUUID()]}]})}::text::jsonb,${admin.userId!})`;
        await owner.client`update data_permission_profile set enabled=true,active_revision_id=${revision} where id=${profile}`;await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by)values(${b.tenantId},${admin.userId!},${profile},${admin.userId!})`;
        expect(await owner.withTenant(admin,tx=>tx.execute(sql`select app.access_function_delegation_floor('function.lifecycle.hr.exceptionRemovals.execute',${b.companyId}::uuid)as allowed`))).toEqual([{allowed:false}]);
        await expect(onboardingCommand(admin,row.case.id,row.revision,{type:'removeItem',itemId:target.id})).rejects.toThrow();
        await expect(onboardingCommand(other,row.case.id,row.revision,{type:'removeItem',itemId:target.id})).rejects.toThrow();
        const [unchanged]=await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id));expect(unchanged!.revision).toBe(row.revision);
        await onboardingCommand(tech,row.case.id,row.revision,{type:'removeItem',itemId:target.id});const [removed]=await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id));expect(removed!.data.extras).toEqual([]);expect(removed!.data.requisitions[0]!.items.find(item=>item.id===target.id)?.removed).toBe(true);
    });
    it('invalidates an exception effect after actual native control revoke and restore, then accepts a new command',async()=>{
        const context=await onboardingContext(admin),config=structuredClone(context.config);config.groups.find(group=>group.id==='group-tech')!.members.push(admin.userId!);config.catalogue.push({id:'epoch-exception',name:'Fictional control-stamp access',type:'system',active:true,rules:{},workflow:null,team:'group-tech',card:false});await onboardingSaveConfig(admin,context.revision,config);const row=await prepared();
        const [before]=await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id)),[baseline]=await owner.db.select().from(schema.lcOnboardingConfig).where(eq(schema.lcOnboardingConfig.tenantId,b.tenantId));
        await expect(withTenant(admin,async tx=>{
            const [effect]=await tx.execute<{function_key:string;native_branch:string}>(sql`select * from app.onboarding_exception_update(${row.case.id}::uuid,${row.revision},'addItem','{"catalogueId":"epoch-exception","reason":"Actual admitted source","approval":false,"confirmedBy":null}'::jsonb)`);
            await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'onboarding-case',aggregateId:row.case.id,eventType:'onboarding.addItem',actor:actorOf(admin),payload:{caseId:row.case.id,companyId:b.companyId,functionKey:effect!.function_key,nativeBranch:effect!.native_branch}});
            await tx.execute(sql`update lc_onboarding_config set data=jsonb_set(data,'{groups}','[]'::jsonb)where tenant_id=${b.tenantId}::uuid`);
            await tx.execute(sql`update lc_onboarding_config set data=${JSON.stringify(baseline!.data)}::jsonb where tenant_id=${b.tenantId}::uuid`);
        })).rejects.toThrow();
        expect(await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id,row.case.id))).toEqual([before]);
        await expect(withTenant(admin,tx=>tx.execute(sql`select * from app.onboarding_exception_update(${row.case.id}::uuid,${row.revision},'addItem','{"catalogueId":"epoch-exception","reason":"Invalid source","approval":false,"confirmedBy":null,"owner":"forged"}'::jsonb)`))).rejects.toThrow();
        await expect(withTenant(admin,tx=>tx.execute(sql`select app.onboarding_exception_routing('{}'::jsonb,'{}'::jsonb,'{}'::jsonb)`))).rejects.toThrow();
        await onboardingCommand(admin,row.case.id,row.revision,{type:'addItem',catalogueId:'epoch-exception',reason:'Fresh admitted source',approval:false,confirmedBy:null});expect((await onboardingList(admin))[0]!.case.requisitions[0]!.items.at(-1)).toMatchObject({catalogueId:'epoch-exception',addedBy:admin.userId});
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
    it('publishes delivery courses and leaves the assigned item visible under Fulfilment Execute denial',async()=>{
        const row=await prepared(),itemId=row.case.requisitions[0]!.items[0]!.id;
        const cap='function.lifecycle.shared.fulfilment.execute';
        const keys=['handover','requisitionNotes','fulfilment','conversations','approvals','approvalAssignments']
            .map(key=>'function.lifecycle.shared.'+key+'.%').concat('function.lifecycle.self.acknowledgement.%');
        try{
            expect(await publishActionCapabilityPackage(owner.client,'lifecycle_delivery')).toMatchObject({changed:true,capabilities:14});
            expect(await publishActionCapabilityPackage(owner.client,'lifecycle_delivery')).toMatchObject({changed:false});
            const read=()=>onboardingTasks(tech).then(rows=>rows.find(task=>task.kind==='team'&&task.caseId===row.case.id));
            expect((await read())?.itemIds).toContain(itemId);
            await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
             values(${b.tenantId}::uuid,${tech.userId!}::uuid,${cap},${b.companyId}::uuid,'deny')`;
            expect((await read())?.itemIds).toContain(itemId);
            const fulfil=()=>onboardingCommand(tech,row.case.id,row.revision,{type:'fulfil',itemId,status:'done'});
            await expect(fulfil()).rejects.toThrow();
            expect((await onboardingList(admin)).find(item=>item.case.id===row.case.id)?.revision).toBe(row.revision);
            await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid and capability_id=${cap}`;
            await fulfil();
            expect((await onboardingList(admin)).find(item=>item.case.id===row.case.id)?.case.requisitions[0]?.items[0]?.state).toBe('ready');
        }finally{
            await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid and capability_id=${cap}`;
            await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id like any(${keys}::text[])`;
        }
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
        expect((await projection(other))[0]!.note).toMatchObject({ body: 'Edited assigned conversation' });
        expect((await projection(other))[0]!.note).not.toHaveProperty('revisions');
        await onboardingNote(tech, row.case.id, { id: note.id, context: 'welcome', body: '', mentions: [], deleted: true });
        expect(await projection(other)).toEqual([]);
        expect(await projection(tech)).toEqual([]);
        const [stored] = await owner.db.select().from(schema.lcOnboardingNote).where(eq(schema.lcOnboardingNote.id, note.id));
        expect(stored?.data).toMatchObject({ deleted: true, body: 'Edited assigned conversation' });
        const [beforeRefusal] = await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id, row.case.id));
        await expect(onboardingNote(other, row.case.id, { context: 'welcome', body: 'Reply after deletion', mentions: [] })).rejects.toThrow();
        await expect(onboardingNote(other, row.case.id, { id: note.id, context: 'welcome', body: '', mentions: [], resolve: true })).rejects.toThrow();
        expect(await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.id, row.case.id))).toEqual([beforeRefusal]);
        expect(await owner.db.select().from(schema.lcOnboardingNote).where(eq(schema.lcOnboardingNote.id, note.id))).toEqual([stored]);
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
    it('finishes only its admitted terminal card effect after the actual source team changes',async()=>{
        const context=await onboardingContext(admin),config=structuredClone(context.config);config.groups.find(group=>group.id==='facility')!.members=[other.userId!];config.catalogue.push({id:'terminal-card',name:'Fictional terminal card',type:'device',active:true,rules:{},workflow:null,team:'facility',card:true});
        await onboardingSaveConfig(admin,context.revision,config);await draft();let row=(await onboardingList(admin))[0]!;await onboardingCommand(admin,row.case.id,row.revision,{type:'saveSubmit',patch:{hiring:'new_hire',local:{supervisor:'Manager'},selected:['terminal-card']}});row=(await onboardingList(admin))[0]!;const item=row.case.requisitions[0]!.items[0]!;
        const native=()=>owner.client`select app.lifecycle_delivery_function_legacy_allowed(${b.tenantId}::uuid,${other.userId!}::uuid,'function.lifecycle.shared.fulfilment.execute',${b.companyId}::uuid)as allowed`;
        expect((await native())[0].allowed).toBe(true);
        await onboardingCommand(other,row.case.id,row.revision,{type:'fulfil',itemId:item.id,status:'done'});row=(await onboardingList(admin))[0]!;
        expect(row.case.requisitions[0]!.items[0]).toMatchObject({id:item.id,stage:'tech',team:'group-tech',state:'printed'});expect((await native())[0].allowed).toBe(false);
        await expect(onboardingCommand(other,row.case.id,row.revision,{type:'fulfil',itemId:item.id,status:'done'})).rejects.toThrow('fulfilling team');
        expect((await owner.client`select count(*)::int as n from app.lifecycle_native_effect_context`)[0].n).toBe(0);
        await onboardingCommand(tech,row.case.id,row.revision,{type:'fulfil',itemId:item.id,status:'done'});expect((await onboardingList(admin))[0]!.case.requisitions[0]!.items[0]!.state).toBe('ready');
    });
    it('refuses a same-transaction native authority revoke and restore after admission, then permits a fresh retry',async()=>{
        const before=await onboardingContext(admin),config=structuredClone(before.config);config.groups.find(group=>group.id==='people-gbs')!.members=[admin.userId!];await onboardingSaveConfig(admin,before.revision,config);const row=await prepared();expect(row.case.tasks.find(task=>task.id==='welcome')?.assignee).toBe(admin.userId);
        const [baseline]=await owner.db.select().from(schema.lcOnboardingConfig).where(eq(schema.lcOnboardingConfig.tenantId,b.tenantId));
        await expect(withTenant(admin,async tx=>{
            await tx.execute(sql`select * from app.onboarding_assigned_task_update(${row.case.id}::uuid,${row.revision},'welcome','progress')`);
            await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'onboarding-case',aggregateId:row.case.id,eventType:'onboarding.task',actor:actorOf(admin),subjectEmploymentId:row.case.employmentId,payload:{caseId:row.case.id,companyId:b.companyId}});
            await tx.execute(sql`update lc_onboarding_config set data=jsonb_set(data,'{groups}','[]'::jsonb)where tenant_id=${b.tenantId}::uuid`);
            await tx.execute(sql`update lc_onboarding_config set data=${JSON.stringify(baseline!.data)}::jsonb where tenant_id=${b.tenantId}::uuid`);
        })).rejects.toThrow();
        const retained=(await onboardingList(admin))[0]!;expect(retained.revision).toBe(row.revision);expect(retained.case.tasks.find(task=>task.id==='welcome')?.status).toBe('todo');
        expect((await owner.db.select().from(schema.lcOnboardingConfig).where(eq(schema.lcOnboardingConfig.tenantId,b.tenantId)))[0]!.data).toEqual(baseline!.data);
        await v9OwnTask(admin,{caseId:row.case.id,revision:row.revision,taskId:'welcome',status:'done',reason:''});expect((await onboardingList(admin))[0]!.case.tasks.find(task=>task.id==='welcome')?.status).toBe('done');
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
    it('binds ACTIVE synchronization to the actual hire and preserves native role and group tasks',async()=>{
        const [manager]=await owner.db.select().from(schema.employment).where(eq(schema.employment.personId,tech.personId!));
        const before=await onboardingContext(admin),config=structuredClone(before.config);
        config.checklists[0]!.tasks.push({id:'source-joiner',name:'Source joiner task',by:'joiner',group:'',method:'manual',opens:null,due:1,gate:false},{id:'source-manager',name:'Source manager task',by:'manager',group:'',method:'manual',opens:null,due:1,gate:false});
        await onboardingSaveConfig(admin,before.revision,config);
        const saved=await saveEmployeeDraft(admin,{data:{profile:{fullName:'Actual source task hire',employeeCode:'ACTUAL-SOURCE-TASK',primaryEmail:'actual-source-task@fixture.invalid'},employment:{companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:todayInKualaLumpur(),reportingManagerEmploymentId:manager!.id},payroll:{basicSalary:'5000'}},currentStep:5});
        let row=(await onboardingList(admin))[0]!;
        await onboardingCommand(admin,row.case.id,row.revision,{type:'saveSubmit',patch:{hiring:'new_hire',selected:['m365']}});
        row=(await onboardingList(admin))[0]!;
        const groupBefore=structuredClone(row.case.tasks.find(task=>task.id==='welcome'));
        let refusal:unknown;try{await withTenant(admin,tx=>tx.execute(sql`select * from app.onboarding_sync_active_draft(${saved.id}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid)`));}catch(error){refusal=error;}expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'42501',message:'Draft activation source unavailable'}));
        expect((await onboardingList(admin))[0]!.revision).toBe(row.revision);
        const active=await completeEmployeeDraft(admin,saved.id),after=(await onboardingList(admin))[0]!;
        expect(after.case).toMatchObject({id:row.case.id,employmentId:active.employmentId,personnelStatus:'Active'});
        expect(after.case.tasks.find(task=>task.id==='welcome')).toEqual(groupBefore);
        expect(after.case.tasks.find(task=>task.id==='source-manager')).toMatchObject({assignee:tech.userId,failure:null});
        expect(after.case.tasks.find(task=>task.id==='source-joiner')).toMatchObject({assignee:null,failure:'The new joiner needs a linked Personnel account.'});
        expect(after.case.history.at(-1)).toMatchObject({action:'personnel.activated',by:admin.userId});
        expect(await withTenant(admin,tx=>tx.execute(sql`select has_function_privilege(current_user,'app.onboarding_sync_draft_source(uuid,uuid,uuid)','EXECUTE') as allowed`))).toEqual([{allowed:false}]);
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
        await onboardingNote(admin, row.case.id, { context: 'requisition', body: 'Earlier administrative text', mentions: [] });
        const [edited] = await owner.db.select().from(schema.lcOnboardingNote).where(eq(schema.lcOnboardingNote.caseId,row.case.id));
        await onboardingNote(admin, row.case.id, { id: edited.id, context: 'requisition', body: 'Please reply', mentions: [other.userId!] });
        await onboardingNote(admin, row.case.id, { context: 'requisition', body: 'Unrelated administrative note', mentions: [] });
        const raw = (actor:SessionContext) => withTenant(actor, tx => tx.select().from(schema.lcOnboardingNote).where(eq(schema.lcOnboardingNote.caseId,row.case.id)));
        expect(await raw(other)).toEqual([]);
        expect((await raw(admin)).find(note=>note.id===edited.id)?.data.revisions?.[0]?.body).toBe('Earlier administrative text');
        const detail = await onboardingDetail(other, row.case.id, 'task');
        expect(detail.canOpenRequisition).toBe(false);
        expect(detail.case.source.email).toBeUndefined();
        expect(detail.case.requisitions[0]!.items).toHaveLength(0);
        expect(detail.notes.map(n=>n.body)).toEqual(['Please reply']);
        expect(detail.notes[0]).not.toHaveProperty('revisions');
        const equipmentReader = await onboardingDetail(tech, row.case.id, 'requisition');
        expect(equipmentReader.notes.find(n=>n.id===edited.id)?.body).toBe('Please reply');
        expect(equipmentReader.notes.find(n=>n.id===edited.id)).not.toHaveProperty('revisions');
        await expect(onboardingDetail(other, row.case.id, 'requisition')).rejects.toThrow('Requisition access');
        expect(await onboardingRequisitions(other)).toHaveLength(0);
        await onboardingNote(other, row.case.id, { context: 'requisition', body: 'Replied without page access', mentions: [] });
        const [ownReply] = await raw(other);
        expect((await raw(other)).map(n=>n.data.body)).toEqual(['Replied without page access']);
        await onboardingNote(other, row.case.id, { id: ownReply.id, context: 'requisition', body: 'Edited own reply', mentions: [] });
        expect((await raw(other))[0]?.data.revisions?.[0]?.body).toBe('Replied without page access');
        expect((await onboardingTasks(other)).some(t => t.kind === 'mention')).toBe(false);
    });
    it('prevents a nonauthor from editing note content even through direct SQL', async () => {
        const row = await prepared();
        await onboardingNote(admin, row.case.id, { context: 'requisition', body: 'Original', mentions: [tech.userId!] });
        const [n] = await owner.db.select().from(schema.lcOnboardingNote);
        const change=sql `update lc_onboarding_note set data=jsonb_set(data,'{body}','"Changed"') where id=${n!.id}::uuid returning id`;
        // An assigned nonauthor only has the finite current-note course, so the raw UPDATE finds no row.
        expect(await withTenant(tech, tx => tx.execute(change))).toEqual([]);
        const secondAdmin:SessionContext={...admin,userId:await createAppUser(b.tenantId,null,'hr_admin'),personId:null};
        const read=sql `select id from lc_onboarding_note where id=${n!.id}::uuid`;
        expect(await withTenant(admin,tx=>tx.execute(read))).toEqual([{id:n!.id}]);
        expect(await withTenant(secondAdmin,tx=>tx.execute(read))).toEqual([]);
        expect(await withTenant(secondAdmin,tx=>tx.execute(change))).toEqual([]);
        expect(await owner.db.select().from(schema.lcOnboardingNote)).toEqual([n]);
    });
});
