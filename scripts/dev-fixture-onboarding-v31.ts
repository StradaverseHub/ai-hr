/** Synthetic V3.1 walkthrough fixture. Refuses every database except the named local disposable one. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
try {
    process.loadEnvFile('.env.local');
}
catch { }
const name = 'ai_hr_onb_v31_ui', out = resolve('scratchpad/onb-v31/fixture.json');
function local(raw: string | undefined) {
    const u = new URL(raw ?? '');
    if (!['postgres:', 'postgresql:'].includes(u.protocol) || !['localhost', '127.0.0.1'].includes(u.hostname) || u.port !== '5433')
        throw Error('Only the local disposable Postgres instance is permitted.');
    u.pathname = '/' + name;
    return u.toString();
}
if (process.env.NODE_ENV === 'production')
    throw Error('This fixture cannot run in production.');
const appUrl = local(process.env.DATABASE_URL), ownerUrl = local(process.env.MIGRATION_DATABASE_URL);
for (const [key, value] of Object.entries({ DATABASE_URL: appUrl, MIGRATION_DATABASE_URL: ownerUrl, TEST_DATABASE_URL: appUrl, TEST_MIGRATION_DATABASE_URL: ownerUrl }))
    process.env[key] = value;
async function main() {
    const adminUrl = new URL(ownerUrl);
    adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const [exists] = await admin `select 1 from pg_database where datname=${name}`;
    if (!exists)
        await admin.unsafe('create database "ai_hr_onb_v31_ui"');
    await admin.unsafe('grant connect on database "ai_hr_onb_v31_ui" to ai_hr_app');
    await admin.end();
    const { drizzle } = await import('drizzle-orm/postgres-js'), { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const migration = postgres(ownerUrl, { max: 1 });
    await migrate(drizzle(migration), { migrationsFolder: 'db/migrations' });
    await migration.end();
    const { seedCatalogsAt } = await import('./seed-catalogs');
    await seedCatalogsAt(ownerUrl);
    const { seedBase, owner, setModule, entitledCtx, createAppUser, closeAll } = await import('../test/harness');
    const { eq, asc, sql } = await import('drizzle-orm'), schema = await import('../db/schema');
    const { hireEmployee } = await import('../core/org');
    const { createBusinessUnit, createDepartment } = await import('../core/admin');
    const { saveEmployeeDraft, completeEmployeeDraft } = await import('../core/employee-draft');
    const { onboardingSetup, onboardingContext, onboardingSaveConfig, onboardingList, onboardingCommand, createOnboardingCase, refreshOnboardingPersonnel, sweepOnboarding } = await import('../packs/lifecycle/service');
    const { todayInKualaLumpur } = await import('../lib/hr-date'), M = await import('../lib/onboarding-model');
    try {
        const prior = await readFile(out, 'utf8').then(JSON.parse, () => null);
        if (prior) {
            const cases = await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.tenantId, prior.tenantId));
            if (!prior.caseIds.every((id: string) => cases.some(c => c.id === id)))
                throw Error('Existing fixture does not match its saved identity; refusing to reset it.');
            // Version 1 recorded physical row order; verify that exact witness before using canonical ID ordering in new fixtures.
            const legacyRows = prior.digestVersion === 2 ? await owner.db.select().from(schema.lcCase).orderBy(asc(schema.lcCase.id)) : await owner.db.select().from(schema.lcCase).orderBy(sql`ctid`), legacyHistory = prior.digestVersion === 2 ? await owner.db.select().from(schema.lcHistory).orderBy(asc(schema.lcHistory.id)) : await owner.db.select().from(schema.lcHistory).orderBy(sql`ctid`);
            if (createHash('sha256').update(JSON.stringify({legacyRows,legacyHistory})).digest('hex') !== prior.legacyDigest)
                throw Error('The legacy preservation witness changed.');
            console.log('Existing isolated onboarding fixture identities and legacy history digest verified without resetting data.');
            return;
        }
        const b = await seedBase();
        await setModule(b.tenantId, 'lifecycle', 'active');
        let bootstrap = await entitledCtx(b);
        const today = todayInKualaLumpur();
        const users: Record<string, {
            id: string;
            personId: string;
            employmentId: string;
            name: string;
        }> = {};
        for (const [key, fullName, role] of [['lina', 'Lina Tan', 'super_admin'], ['sarah', 'Sarah Lim', 'hr_admin'], ['farid', 'Farid Ismail', 'hr_admin'], ['kevin', 'Kevin Tan', 'employee'], ['aina', 'Aina Zulkifli', 'employee'], ['raj', 'Raj Kumar', 'employee'], ['mei', 'Lee Mei Ling', 'employee'], ['hafiz', 'Hafiz Rahman', 'employee'], ['nadia', 'Nadia Hassan', 'employee']] as const) {
            const h = await hireEmployee(bootstrap, { companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: M.dayDate(today, -365), person: { fullName, primaryEmail: key + '@onb-fixture.example.test' } });
            users[key] = { id: await createAppUser(b.tenantId, h.personId, role), personId: h.personId, employmentId: h.employmentId, name: fullName };
        }
        const master = { ...bootstrap, userId: users.lina!.id, personId: users.lina!.personId, roles: ['super_admin'] };
        const hr = { ...bootstrap, userId: users.sarah!.id, personId: users.sarah!.personId, roles: ['hr_admin'] };
        const manufacturing = await createBusinessUnit(master, { companyId: b.companyId, code: 'DEMO-MFG', name: 'Manufacturing' });
        const construction = await createBusinessUnit(master, { companyId: b.companyId, code: 'DEMO-CON', name: 'Construction' });
        const manufacturingDept = await createDepartment(master, { companyId: b.companyId, name: 'Manufacturing Finance', businessUnitId: manufacturing.id });
        const constructionDept = await createDepartment(master, { companyId: b.companyId, name: 'Construction Projects', businessUnitId: construction.id });
        await onboardingSetup(master);
        let context = await onboardingContext(master);
        const cfg = structuredClone(context.config);
        cfg.access.onboarding = [users.sarah!.id, users.farid!.id];
        cfg.groups.find(g => g.id === 'people-gbs')!.members = [users.sarah!.id, users.farid!.id];
        cfg.groups.find(g => g.id === 'group-tech')!.members = [users.kevin!.id, users.aina!.id];
        cfg.groups.find(g => g.id === 'facility')!.members = [users.nadia!.id];
        cfg.groups.find(g => g.id === 'tech-bp')!.members = [users.raj!.id, users.mei!.id, users.hafiz!.id];
        cfg.groups.push({ id: 'manufacturing-bp', name: 'Tech BP – Manufacturing', members: [users.mei!.id, users.hafiz!.id], limit: 4 }, { id: 'construction-bp', name: 'Tech BP – Construction', members: [users.raj!.id], limit: 4 });
        cfg.routings = [{ id: 'bp-routing', name: 'Tech BP routing', rows: [{ id: 'mfg', rules: { businessGroup: [manufacturing.id] }, group: 'manufacturing-bp' }, { id: 'con', rules: { businessGroup: [construction.id] }, group: 'construction-bp' }, { id: 'default', rules: {}, group: 'tech-bp' }] }];
        cfg.workflows[0]!.steps = [{ id: 'bp-step', label: 'Tech BP approval', type: 'routing', target: 'bp-routing', method: 'rr' }];
        cfg.catalogue = [
            { id: 'm365', name: 'Microsoft 365', type: 'system', active: true, rules: {}, workflow: null, team: 'group-tech', card: false },
            { id: 'vpn', name: 'VPN', type: 'system', active: true, rules: { businessGroup: [manufacturing.id] }, workflow: 'standard', team: 'group-tech', card: false },
            { id: 'autocad', name: 'AutoCAD', type: 'system', active: true, rules: { businessGroup: [construction.id] }, workflow: null, team: 'group-tech', card: false },
            { id: 'laptop', name: 'Laptop', type: 'device', active: true, rules: {}, workflow: null, team: 'group-tech', card: false },
            { id: 'card', name: 'Access card', type: 'device', active: true, rules: {}, workflow: null, team: 'facility', card: true },
            { id: 'printer', name: 'Printer access', type: 'system', active: true, rules: {}, workflow: null, team: 'group-tech', card: false },
        ];
        cfg.checklists[0]!.owner = users.sarah!.id;
        cfg.checklists[0]!.name = 'Standard onboarding';
        cfg.checklists[0]!.tasks = [
            { id: 'welcome', name: 'Prepare welcome pack', by: 'group', group: 'people-gbs', method: 'rr', opens: null, due: -1, gate: false },
            { id: 'acceptance', name: 'Device Acceptance Acknowledgement', by: 'joiner', group: '', method: 'manual', opens: 1, due: 1, gate: true },
            { id: 'manager', name: 'Welcome the new joiner', by: 'manager', group: '', method: 'manual', opens: 1, due: 1, gate: false },
            { id: 'survey', name: 'Day 7 onboarding survey', by: 'group', group: 'people-gbs', method: 'rr', opens: 7, due: 14, gate: false },
        ];
        await onboardingSaveConfig(master, context.revision, cfg);
        const pending = await saveEmployeeDraft(hr, { data: { profile: { fullName: 'Muhammad Haziq', employeeCode: 'DEMO-HZ-001', primaryEmail: 'haziq@onb-fixture.example.test' }, employment: { companyId: b.companyId, departmentId: manufacturingDept.id, positionId: b.positionId, hiredOn: M.dayDate(today, 5), employmentType: 'full_time', reportingManagerEmploymentId: users.farid!.employmentId } }, currentStep: 2 });
        const ameliaDraft = await saveEmployeeDraft(hr, { data: { profile: { fullName: 'Amelia Tan', employeeCode: 'DEMO-AM-002', primaryEmail: 'amelia@onb-fixture.example.test' }, employment: { companyId: b.companyId, departmentId: constructionDept.id, positionId: b.positionId, hiredOn: today, employmentType: 'full_time', reportingManagerEmploymentId: users.farid!.employmentId }, payroll: { basicSalary: '5000' } }, currentStep: 2 });
        await saveEmployeeDraft(hr, { data: { profile: { fullName: 'Fictional Unscheduled Hire' }, employment: { companyId: b.companyId } }, currentStep: 1 });
        let rows = await onboardingList(hr), amelia = rows.find(r => M.effectiveFacts(r.case).fullName === 'Amelia Tan')!;
        await onboardingCommand(hr, amelia.case.id, amelia.revision, { type: 'saveSubmit', patch: { hiring: 'new_hire', selected: ['m365', 'laptop', 'card'], local: { gbsTa: 'Farid Ismail' }, notes: 'Synthetic fixture: prepare a quiet workstation.' } });
        const activated = await completeEmployeeDraft(hr, ameliaDraft.id);
        const [activeEmployee] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, activated.employmentId));
        users.amelia = { id: await createAppUser(b.tenantId, activeEmployee!.personId, 'employee'), personId: activeEmployee!.personId, employmentId: activeEmployee!.id, name: 'Amelia Tan' };
        await refreshOnboardingPersonnel(master);
        await sweepOnboarding(master);
        const legacy = await createOnboardingCase(master, { companyId: b.companyId, fullName: 'Fictional legacy hire', employeeNo: 'DEMO-OLD-1', joinDate: today, jobTitle: 'Analyst', department: 'Finance', supervisor: 'Sarah Lim', laptopRequired: true, carparkRequired: false });
        const legacyRows = await owner.db.select().from(schema.lcCase).orderBy(asc(schema.lcCase.id)), legacyHistory = await owner.db.select().from(schema.lcHistory).orderBy(asc(schema.lcHistory.id));
        rows = await onboardingList(hr);
        await mkdir(resolve('scratchpad/onb-v31'), { recursive: true });
        await writeFile(out, JSON.stringify({ synthetic: true, digestVersion: 2, tenantId: b.tenantId, companyId: b.companyId, users, caseIds: rows.map(r => r.case.id), haziq: rows.find(r => r.case.sourceDraftId === pending.id)!.case.id, amelia: amelia.case.id, legacyId: legacy.id, legacyDigest: createHash('sha256').update(JSON.stringify({ legacyRows, legacyHistory })).digest('hex') }, null, 2), { mode: 0o600, flag: 'wx' });
        console.log('Created three isolated onboarding journeys, nine staff personas and a new-joiner account and a legacy preservation witness.');
    }
    finally {
        await closeAll();
    }
}
main().then(() => process.exit(0), e => { console.error(e instanceof Error ? e.message : 'Onboarding fixture failed'); process.exit(1); });
