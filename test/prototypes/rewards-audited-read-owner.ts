/** Exact legacy binding; bounded native proofs inject their separately owned controller. */
import {owner,migrateTestDb,closeAll} from '../harness';
import {createRewardsAuditFixtureOwner} from './rewards-audited-read-owner-factory';
export function rewardsAuditFixtureOwner(){return createRewardsAuditFixtureOwner({owner,migrateTestDb,closeAll});}
export type RewardsAuditFixtureOwner=Awaited<ReturnType<typeof rewardsAuditFixtureOwner>>;
