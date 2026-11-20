import 'server-only';
import { after } from 'next/server';
import { recordPayslipOpened } from '@/core/payroll-audit/access-log';
import type { SessionContext } from '@/db/client';

/** Record the authorised HTML view without making the display wait for the best-effort audit write. */
export function schedulePayslipOpenAudit(session: SessionContext, payslipId: string) {
  after(async () => {
    await recordPayslipOpened(session, { payslipId, channel: 'web' }).catch(() => null);
  });
}
