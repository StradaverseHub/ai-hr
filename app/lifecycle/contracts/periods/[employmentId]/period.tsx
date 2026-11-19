'use client';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ContractSharedPeriodContext } from '@/packs/contracts/service';
import { useContractSharedCopy } from '@/lib/contract-shared-copy';
import { openSharedPeriod } from '../../shared-actions';
import {
  SharedContractNavigation,
  ContractPanel,
  ContractFeedback,
  contractDate,
  contractSalary,
} from '../../shared-case-ui';
export function SharedContractPeriod({
  period,
  canOpenPersonnel,
}: {
  period: ContractSharedPeriodContext;
  canOpenPersonnel: boolean;
}) {
  const copy = useContractSharedCopy(),
    router = useRouter(),
    [busy, start] = useTransition(),
    [error, setError] = useState('');
  function open() {
    start(async () => {
      setError('');
      try {
        const response = await openSharedPeriod({
          employmentId: period.employmentId,
          sourceRevision: period.sourceRevision,
        });
        if (response.ok) router.push('/lifecycle/contracts/' + response.value.caseId);
        else setError(response.error);
      } catch {
        setError('The case could not be started. Try again.');
      }
    });
  }
  return (
    <div className="v9-stack">
      <header className="v9-heading">
        <div>
          <h1>{period.source.name}</h1>
          <p>
            {period.source.employeeId} · {period.source.company}
          </p>
        </div>
        <Link className="v9-button" href="/lifecycle/contracts">
          {copy('Back to contract cases')}
        </Link>
      </header>
      <SharedContractNavigation />
      <ContractFeedback error={error} />
      <ContractPanel title={copy('Current Personnel contract period')}>
        <dl className="contract-facts">
          <div>
            <dt>{copy('Contract number')}</dt>
            <dd>{period.source.contractNumber ?? copy('Needs verification')}</dd>
          </div>
          <div>
            <dt>{copy('Contract dates')}</dt>
            <dd>
              {contractDate(period.source.startOn)}–{contractDate(period.source.endOn)}
            </dd>
          </div>
          <div>
            <dt>{copy('Department / position')}</dt>
            <dd>
              {period.source.department} · {period.source.designation}
            </dd>
          </div>
          <div>
            <dt>{copy('Direct Superior')}</dt>
            <dd>{period.source.manager || copy('Not assigned')}</dd>
          </div>
          <div>
            <dt>{copy('Current basic salary')}</dt>
            <dd>
              {period.permissions.includes('seePay') ? contractSalary(period.source.salaryCents) : copy('Restricted')}
            </dd>
          </div>
        </dl>
        <p>
          {copy(
            'No case has been opened for this Personnel period. Viewing these facts creates no case, workflow, notification or posting.',
          )}
        </p>
        {period.sourceIssue === 'native_intake_required' ? (
          <p className="v9-notice">
            {copy('Complete the native first post-retirement intake with its authorised owner.')}{' '}
            <Link href="/lifecycle/contracts/intake">{copy('Open native intake')}</Link>
          </p>
        ) : (
          period.sourceIssue && (
            <p className="v9-notice">
              {copy(
                'People Ops must verify the current contract number and dates in Personnel Management before a case can start.',
              )}
            </p>
          )
        )}
        {period.canOpen && (
          <p className="v9-muted">
            {copy(
              'Starting a case can run configured case-opening workflows. Personnel and Payroll records stay unchanged.',
            )}
          </p>
        )}
        <div className="v9-actions">
          {period.canOpen && (
            <button className="v9-button v9-button-primary" disabled={busy} aria-busy={busy} onClick={open}>
              {copy('Start contract case')}
            </button>
          )}
          {canOpenPersonnel && (
            <Link className="v9-button" href={`/admin/personnel/${period.employmentId}`}>
              {copy('Open Personnel record')}
            </Link>
          )}
        </div>
        {!period.canOpen && !period.sourceIssue && (
          <p className="v9-muted">
            {copy('The authorised decision owner can start this case. Your current access is read-only.')}
          </p>
        )}
      </ContractPanel>
    </div>
  );
}
