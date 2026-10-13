import type { ReactNode } from 'react';
import { ControlTowerNavigation } from './navigation';
import { requireAdmin } from '@/lib/authz';
import { isModuleEnabled } from '@/core/entitlements';

export default async function ControlTowerLayout({ children }: { children: ReactNode }) {
  const session = await requireAdmin();
  return <><ControlTowerNavigation payrollEnabled={isModuleEnabled(session, 'payroll')} />{children}</>;
}
