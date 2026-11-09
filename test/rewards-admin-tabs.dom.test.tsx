import { describe, expect, it } from 'vitest';
import { navigationRouteOwner } from '../lib/navigation-workspaces';
import { rewardsPack } from '../packs/rewards';

describe('Rewards sidebar navigation', () => {
  const destinations = rewardsPack.navLinks ?? [];

  it('shows promotion nominations under Managing Rewards and retires Review Cycles', () => {
    expect(destinations).toEqual(expect.arrayContaining([
      expect.objectContaining({ href: '/rewards/promotions', group: 'manage' }),
      expect.objectContaining({ href: '/rewards/reviews', group: 'manage' }),
    ]));
    expect(destinations.some(row => row.href === '/admin/rewards')).toBe(false);
  });

  it('assigns approved plans to Shared Rewards Configuration in the sidebar', () => {
    const route = navigationRouteOwner('/admin/rewards/plans', 'version=approved', destinations);
    expect(route?.destination.href).toBe('/admin/rewards/shared');
    expect(navigationRouteOwner('/admin/rewards/fictional-review', '', destinations)?.destination.href).toBe('/rewards/reviews');
    expect(navigationRouteOwner('/admin/rewards/setup-access', '', destinations)?.destination.href).toBe('/admin/rewards/access');
    expect(navigationRouteOwner('/rewards/fictional-review/setup', '', destinations)?.destination.href).toBe('/rewards');
  });
});
