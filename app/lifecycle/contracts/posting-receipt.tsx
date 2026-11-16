'use client';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ContractSharedPostingSummary } from '@/packs/contracts/service';
import { useContractSharedCopy } from '@/lib/contract-shared-copy';
import { ContractPanel, ContractFeedback, contractDate } from './shared-case-ui';
import { contractTimestamp } from './shared';
import { confirmSharedPay } from './shared-actions';
export function ContractPostingReceipt({
  caseId,
  summary,
  today,
  payChanges,
}: {
  caseId: string;
  summary: ContractSharedPostingSummary;
  today: string;
  payChanges: boolean;
}) {
  const copy = useContractSharedCopy(),
    router = useRouter(),
    [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState(''),
    [busy, start] = useTransition();
  function confirm() {
    start(async () => {
      setError('');
      try {
        const result = await confirmSharedPay({ caseId, expectedRevision: summary.caseRevision, confirmed });
        if (result.ok) router.refresh();
        else setError(result.error);
      } catch {
        setError('The pay confirmation could not be recorded. Review the current receipt and try again.');
      }
    });
  }
  return (
    <ContractPanel title={copy('Personnel posting and pay confirmation')}>
      <ContractFeedback error={error} />
      <p>
        <strong>{summary.label}</strong> ·{' '}
        {copy(summary.eventType === 'contractRenewal' ? 'Renewal' : 'Conversion to permanent')} ·{' '}
        {copy(summary.status === 'approved' ? 'Approved' : 'Approval pending')}
      </p>
      <dl className="contract-facts">
        <div>
          <dt>{copy('Posting approver group')}</dt>
          <dd>{summary.approverGroupName ?? copy('Not configured')}</dd>
        </div>
        <div>
          <dt>{copy('Approval receipt')}</dt>
          <dd>
            {summary.approvedAt ? (
              <>
                {summary.approvedByName ?? copy('Recorded authorised actor')} · {contractTimestamp(summary.approvedAt)}
              </>
            ) : (
              copy('Waiting for the current posting approver group')
            )}
          </dd>
        </div>
        <div>
          <dt>{copy('Personnel application')}</dt>
          <dd>
            {summary.movementAppliedAt
              ? copy('Applied') + ' · ' + contractTimestamp(summary.movementAppliedAt)
              : summary.status === 'approved'
                ? copy(summary.effectiveDate > today ? 'Scheduled for' : 'Awaiting Personnel application') +
                  ' ' +
                  contractDate(summary.effectiveDate)
                : copy('Applies after approval on its effective date')}
          </dd>
        </div>
        <div>
          <dt>{copy('Manual Payroll confirmation')}</dt>
          <dd>
            {summary.payConfirmedAt ? (
              <>
                {summary.payConfirmedByName ?? copy('Recorded authorised actor')} ·{' '}
                {contractTimestamp(summary.payConfirmedAt)}
              </>
            ) : (
              copy(
                payChanges
                  ? 'No confirmation recorded'
                  : 'No pay change was proposed; Payroll confirmation is not required.',
              )
            )}
          </dd>
        </div>
      </dl>
      {summary.status === 'approved' && !summary.movementAppliedAt && (
        <p className="v9-muted">
          {copy(
            summary.effectiveDate > today
              ? 'This approved movement is scheduled. Current Personnel dates, contract number and employment type remain unchanged until the native movement applies.'
              : 'This approved movement is awaiting Personnel application. Current Personnel dates, contract number and employment type remain unchanged until it applies.',
          )}
        </p>
      )}
      {summary.canConfirmPay && (
        <div className="v9-stack">
          <p>
            {copy(
              'Update the agreed pay manually in Personnel Management › Payroll before confirming. This confirmation records your attestation; it does not write Payroll.',
            )}
          </p>
          <label className="v9-actions">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            {copy('I confirm that Payroll has been manually updated to match the approved terms.')}
          </label>
          <button
            className="v9-button v9-button-primary"
            disabled={busy || !confirmed}
            aria-busy={busy}
            onClick={confirm}
          >
            {copy('Confirm manual Payroll update')}
          </button>
        </div>
      )}
      <Link href={'/lifecycle/contracts/postings?status=' + (summary.status === 'approved' ? 'approved' : 'pending')}>
        {copy('Open Personnel postings')}
      </Link>
    </ContractPanel>
  );
}
