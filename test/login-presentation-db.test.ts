import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, withTenant } from '../db/client';
import * as schema from '../db/schema';
import { readLoginPresentationEditor, saveLoginPresentation } from '../core/login-presentation';
import { DEFAULT_LOGIN_PRESENTATION } from '../lib/login-presentation';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b: Base;
beforeAll(migrateTestDb); afterAll(closeAll); beforeEach(async () => { await resetDb(); b = await seedBase(); });
const groupCtx = () => ({ ...adminCtx(b), grants: [{ role: 'hr_admin', companyId: null }] });
const media = { mediaType: 'image', mediaUrl: 'https://example.test/welcome.png', alt: 'Fictional organization', iconUrl: 'https://example.test/icon.png' };
describe('persisted public presentation with group administration', () => {
  it('saves, reopens, publishes only presentation fields and audits the actor', async () => {
    const ctx = groupCtx();
    expect(await readLoginPresentationEditor(ctx)).toEqual({ revision: 0, presentation: DEFAULT_LOGIN_PRESENTATION });
    await saveLoginPresentation(ctx, media, 0);
    expect(await readLoginPresentationEditor(ctx)).toEqual({ revision: 1, presentation: media });
    const [publicRow] = await client.unsafe('select app.public_login_presentation($1::uuid) as presentation', [b.tenantId]);
    expect(publicRow.presentation).toEqual(media); expect(publicRow.presentation).not.toHaveProperty('tenantId');
    const events = await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId, b.tenantId)).orderBy(schema.domainEvent.sequence);
    expect(events.find(event => event.eventType === 'login-presentation.updated')).toMatchObject({ actorId: ctx.userId, payload: { revision: 1, mediaType: 'image' } });
  });
  it('refuses ordinary and company-scoped administrators, forged grants and a revoked group grant', async () => {
    const [person] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Fictional login viewer', primaryEmail: 'fictional.login@example.test' }).returning();
    const employeeId = await createAppUser(b.tenantId, person.id, 'employee');
    const employee = { ...adminCtx(b), userId: employeeId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
    await expect(saveLoginPresentation(employee, media, 0)).rejects.toThrow('forbidden');
    await expect(saveLoginPresentation({ ...employee, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: b.companyId }] }, media, 0)).rejects.toThrow('forbidden');
    await expect(saveLoginPresentation({ ...employee, roles: ['super_admin'], grants: [{ role: 'super_admin', companyId: null }] }, media, 0)).rejects.toThrow('forbidden');
    const ctx = groupCtx();
    await owner.db.update(schema.roleAssignment).set({ role: 'employee' }).where(eq(schema.roleAssignment.appUserId, ctx.userId!));
    await expect(saveLoginPresentation(ctx, media, 0)).rejects.toThrow('forbidden');
  });
  it('prevents foreign writes and stale overwrites; clearing media preserves the icon', async () => {
    const ctx = groupCtx();
    await saveLoginPresentation(ctx, media, 0);
    await expect(saveLoginPresentation(ctx, { ...media, alt: 'stale' }, 0)).rejects.toThrow('conflict');
    const [foreign] = await owner.db.insert(schema.tenant).values({ workosOrgId: 'org_login_presentation_foreign', name: 'Fictional foreign tenant' }).returning();
    expect(await withTenant(ctx, tx => tx.select().from(schema.loginPresentation).where(eq(schema.loginPresentation.tenantId, foreign.id)))).toEqual([]);
    await expect(withTenant(ctx, tx => tx.insert(schema.loginPresentation).values({ tenantId: foreign.id, presentation: media as never, revision: 1 }))).rejects.toThrow();
    await saveLoginPresentation(ctx, { ...media, mediaType: 'none' }, 1);
    expect((await readLoginPresentationEditor(ctx)).presentation).toEqual({ ...DEFAULT_LOGIN_PRESENTATION, iconUrl: media.iconUrl });
    const [row] = await client.unsafe('select app.public_login_presentation($1::uuid) as presentation', [foreign.id]); expect(row.presentation).toBeNull();
  });
});
