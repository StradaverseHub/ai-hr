import { describe, expect, it, vi } from 'vitest';
const { set, revalidatePath, redirect } = vi.hoisted(() => ({ set: vi.fn(), revalidatePath: vi.fn(), redirect: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set }) }));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/navigation', () => ({ redirect }));
import { setCompanyScope } from '../app/scope-actions';
describe('23e87eef: company-switch inquiry navigation', () => {
  it('resets selection/page at exactly the two inquiry routes after persisting scope', async () => {
    for (const path of ['/leave/employee-balances', '/leave/employee-records']) {
      vi.clearAllMocks(); const form = new FormData(); form.append('companyId', 'company-a'); form.append('returnPath', path);
      await setCompanyScope(form);
      expect(set).toHaveBeenCalledWith('company_scope', 'company-a', { sameSite: 'lax', path: '/' });
      expect(revalidatePath).toHaveBeenCalledWith('/', 'layout'); expect(redirect).toHaveBeenCalledWith(path);
      expect(set.mock.invocationCallOrder[0]).toBeLessThan(redirect.mock.invocationCallOrder[0]);
    }
  });
  it('preserves the default other-route behavior and refuses forged redirect destinations', async () => {
    for (const path of [undefined, 'https://evil.test', '//evil.test', '/leave/employee-balances?emp=other&page=8', '/personnel']) {
      vi.clearAllMocks(); const form = new FormData(); form.append('companyId', 'company-a'); if (path) form.append('returnPath', path);
      await setCompanyScope(form); expect(revalidatePath).toHaveBeenCalled(); expect(redirect).not.toHaveBeenCalled();
    }
  });
});
