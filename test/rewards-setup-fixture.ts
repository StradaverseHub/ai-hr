import {owner} from './harness';
import {approvedRewardFixtures} from '../scripts/fixtures/reward-approved';

export const {setupChecker,setupGrades,setupCompanyStructureFixture,confirmFixturePat,setupRewardLibrariesFixture,createApprovedRewardUnit}=approvedRewardFixtures(owner);
