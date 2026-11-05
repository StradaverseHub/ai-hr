import { Gift } from 'lucide-react';
import { registerPack, type ModulePack } from '../registry';

export const rewardsPack: ModulePack = {
  id: 'rewards', kind: 'module', serviceFacade: 'packs/rewards/service',
  navLinks: [
    { group: 'manage', href: '/rewards', labelKey: 'rewardsReviewing', icon: Gift },
    { group: 'manage', href: '/rewards/analytics', labelKey: 'rewardsAnalytics', icon: Gift },
    { group: 'manage', href: '/rewards/approvals', labelKey: 'rewardsApprovalsBoard', icon: Gift },
    { group: 'admin', href: '/rewards/rules', labelKey: 'rewardsRules', icon: Gift },
    { group: 'admin', href: '/admin/rewards', labelKey: 'rewardsReviewCycles', icon: Gift },
    { group: 'admin', href: '/admin/rewards/shared', labelKey: 'rewardsSharedConfiguration', icon: Gift },
    { group: 'admin', href: '/admin/rewards/salary-structures', labelKey: 'rewardsSalaryStructures', icon: Gift },
    { group: 'admin', href: '/admin/rewards/bonus-matrices', labelKey: 'rewardsBonusMatrices', icon: Gift },
    { group: 'admin', href: '/admin/rewards/pat-inputs', labelKey: 'rewardsPatInputs', icon: Gift },
    { group: 'admin', href: '/admin/rewards/access', labelKey: 'rewardsAccess', icon: Gift },
  ],
  satelliteTables: ['reward_cycle', 'reward_unit', 'reward_member', 'reward_entry', 'reward_decision', 'reward_calendar'].map(table => ({ table })),
};
registerPack(rewardsPack);

// Public client-safe calendar contract; canonical validation and values stay pack-owned.
export {rewardCalendarSchema,emptyRewardCalendar,rewardCalendarStages,rewardOffcycleSlaStages} from './calendar';
export type {RewardCalendarValues} from './calendar';
