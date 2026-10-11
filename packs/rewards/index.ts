import { Gift } from 'lucide-react';
import { registerPack, type ModulePack } from '../registry';

export const rewardsPack: ModulePack = {
  id: 'rewards', kind: 'module', serviceFacade: 'packs/rewards/service',
  navLinks: [
    { group: 'manage', href: '/rewards', labelKey: 'rewards', icon: Gift },
    { group: 'admin', href: '/admin/rewards', labelKey: 'rewards', icon: Gift, adminOnly: true },
  ],
  satelliteTables: ['reward_cycle', 'reward_unit', 'reward_member', 'reward_entry', 'reward_decision'].map(table => ({ table })),
};
registerPack(rewardsPack);
