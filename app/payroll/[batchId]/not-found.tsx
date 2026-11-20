import { PageHeader, pageWideCls } from '@/components/ui';

/** Keep missing and out-of-scope runs inside the same Payroll segment. */
export default function PayrollRunNotFound() {
  return (
    <div className={pageWideCls}>
      <PageHeader title="404" description="This page could not be found." />
    </div>
  );
}
