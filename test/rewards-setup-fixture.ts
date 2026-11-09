import {sql} from 'drizzle-orm';
import {owner} from './harness';
import {approvedRewardFixtures} from '../scripts/fixtures/reward-approved';

const fixtures=approvedRewardFixtures(owner);
export const {setupChecker,setupGrades,setupCompanyStructureFixture,confirmFixturePat,setupRewardLibrariesFixture}=fixtures;
/** New review admission tests use the real application default and must complete checked preparation. */
export const createPreparingRewardUnit=fixtures.createApprovedRewardUnit;
/** Existing Rewards regressions exercise the explicitly retained historical workflow. Only the test
 * owner may give these fixtures the legacy-unrecorded marker. Production creation remains checked. */
export async function createApprovedRewardUnit(...args:Parameters<typeof fixtures.createApprovedRewardUnit>){
 const id=await fixtures.createApprovedRewardUnit(...args);
 await owner.db.execute(sql`update public.reward_unit set preparation_required=false where id=${id}::uuid and tenant_id=${args[0].tenantId}::uuid`);
 return id;
}
