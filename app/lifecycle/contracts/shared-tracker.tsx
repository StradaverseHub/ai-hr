'use client';
import { useContractSharedCopy } from '@/lib/contract-shared-copy';
import Link from 'next/link';
import type {
  contractSharedTracker,
  ContractTrackerQuery,
  ContractTrackerRow,
  ContractWaitingMetadata,
} from '@/packs/contracts/service';
import {ContractAttention} from './attention';
import { SharedContractNavigation, contractDate } from './shared-case-ui';
function trackerStatus(row: ContractTrackerRow) {
  if (row.stage && ['renewed', 'converted', 'offboarding', 'superseded'].includes(row.stage)) return 'Closed';
  if ((row.stage && row.stage !== 'open') || row.sourceIssue === 'legacy_in_progress') return 'In progress';
  return row.decisionNeeded ? 'Decision needed' : 'Upcoming';
}
function nextStep(row: ContractTrackerRow) {
  if (row.sourceIssue === 'native_intake_required')
    return 'Complete native first post-retirement intake with its authorised owner';
  if (row.sourceIssue === 'period_changed') return 'People Ops · Review changed Personnel period';
  if (row.sourceIssue === 'verify_period') return 'People Ops · Verify Personnel dates and contract number';
  if (row.sourceIssue === 'legacy_in_progress') return 'Continue existing workflow';
  if (row.flags.includes('employee_cannot_sign')) return 'People Ops · Check employee account';
  if (row.flags.includes('sent_back')) return 'Letter owner · Review and resend';
  if (row.flags.includes('posting_mismatch')) return 'Posting approver · Review agreed terms';
  if (row.flags.includes('template_stopped') || row.flags.includes('no_workflow'))
    return 'People Ops · Review HR Automation setup';
  if (row.stage === 'approval') return 'Current approval layer';
  if (row.stage === 'document') return 'Current letter routing step';
  if (row.stage === 'posting') return 'Posting approver group';
  if (row.stage === 'pay') return 'Posting approver · Confirm manual Payroll entry';
  if (row.stage === 'offboarding') return 'Offboarding team';
  if (row.scheduledPeriod)
    return row.scheduledPeriod.status === 'scheduled'
      ? 'Personnel · Scheduled employment change'
      : 'Personnel · Awaiting effective-date application';
  if (row.stage === 'renewed' || row.stage === 'converted' || row.stage === 'superseded') return 'Completed';
  return 'Direct Superior / decision owner';
}
export function SharedContractTracker({
  page,
  query,
  waiting,
}: {
  page: Awaited<ReturnType<typeof contractSharedTracker>>;
  query: ContractTrackerQuery;
  waiting: ContractWaitingMetadata[];
}) {
  const copy = useContractSharedCopy();
  function href(offset: number) {
    const params = new URLSearchParams();
    if (query.search) params.set('search', query.search);
    if(query.attention) params.set('attention','true');
    if (query.companyId) params.set('companyId', query.companyId);
    if (query.status && query.status !== 'all') params.set('status', query.status);
    params.set('offset', String(offset));
    return '/lifecycle/contracts?' + params;
  }
  return (
    <div className="v9-stack">
      <header className="v9-heading">
        <div>
          <h1>{copy('Contract Management')}</h1>
          <p>{copy('Track current contract periods, decisions and the person or team needed next.')}</p>
        </div>
      </header>
      <SharedContractNavigation />
      <dl className="contract-summary">{([['total','Current periods'],['upcoming','Upcoming'],['decision','Decision needed'],['inProgress','In progress'],['closed','Closed'],['attention','Needs attention']] as const).map(([key,label])=><div key={key}><dt>{copy(label)}</dt><dd>{page.summary[key]}</dd></div>)}</dl>
      <section className="v9-panel v9-stack">
        <form className="contract-toolbar" action="/lifecycle/contracts">
          <label className="contract-checkbox"><input type="checkbox" name="attention" value="true" defaultChecked={query.attention||query.status==='attention'}/>{copy('Needs attention only')}</label>
          <label className="v9-field">
            <span>{copy('Search')}</span>
            <input
              className="v9-input"
              name="search"
              defaultValue={query.search}
              maxLength={100}
              placeholder={copy('Employee, code, company or department')}
            />
          </label>
          <label className="v9-field">
            <span>{copy('Status')}</span>
            <select name="status" defaultValue={query.status ?? 'all'}>
              <option value="all">{copy('All current periods')}</option>
              <option value="upcoming">{copy('Upcoming')}</option>
              <option value="decision">{copy('Decision needed')}</option>
              <option value="progress">{copy('In progress')}</option>
              <option value="closed">{copy('Closed')}</option>
            </select>
          </label>
          <label className="v9-field">
            <span>{copy('Company')}</span>
            <select name="companyId" defaultValue={query.companyId ?? ''}>
              <option value="">{copy('All companies')}</option>
              {page.companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </label>
          <button className="v9-button v9-button-primary" type="submit">
            {copy('Apply filters')}
          </button>
          <Link className="v9-button" href="/lifecycle/contracts">
            {copy('Clear')}
          </Link>
        </form>
        <p className="v9-muted">
          {page.total} {copy(' matching ')}
          {page.total === 1 ? 'period' : 'periods'}{' '}
          {copy(' · Contract dates and number come from Personnel Management. Current salary is not displayed here.')}
        </p>
        <div className="v9-table-scroll">
          <table className="v9-table contract-table">
            <thead>
              <tr>
                <th scope="col">{copy('Employee')}</th>
                <th scope="col">{copy('Company / department')}</th>
                <th scope="col">{copy('Contract period')}</th>
                <th scope="col">{copy('Status')}</th>
                <th scope="col">{copy('Next owner / attention')}</th>
                <th scope="col">{copy('Action')}</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.employeeName}</strong>
                    <small>
                      {row.employeeCode || '—'} · {row.position || '—'}
                    </small>
                  </td>
                  <td>
                    {row.company}
                    <small>
                      {row.businessGroup} · {row.department || '—'}
                    </small>
                  </td>
                  <td>
                    {copy('Contract #')}
                    {row.contractNumber ?? 'Unverified'}
                    <small>
                      {contractDate(row.startOn)}–{contractDate(row.endOn)}
                    </small>
                    {row.scheduledPeriod && (
                      <small>
                        <Link href={`/lifecycle/contracts/${row.caseId}`}>
                          {copy('Approved next period')} ·{' '}
                          {row.scheduledPeriod.status === 'scheduled'
                            ? copy('Scheduled')
                            : copy('Awaiting Personnel application')}
                        </Link>
                        <br />
                        {row.scheduledPeriod.eventType === 'contractConversion'
                          ? copy('Permanent from')
                          : copy('Contract #') + row.scheduledPeriod.contractNumber + ' · '}{' '}
                        {contractDate(row.scheduledPeriod.startOn)}
                        {row.scheduledPeriod.endOn && '–' + contractDate(row.scheduledPeriod.endOn)}
                      </small>
                    )}
                  </td>
                  <td>
                    <span className="contract-status">{copy(trackerStatus(row))}</span>
                    {row.endPassed &&
                      !['renewed', 'converted', 'offboarding', 'superseded'].includes(row.stage ?? '') && (
                        <small>{copy('Past end date')}</small>
                      )}
                  </td>
                  <td>
                    {waiting.find((item) => item.caseId === row.caseId)?.waitingOn || copy(nextStep(row))}
                    {waiting.find((item) => item.caseId === row.caseId)?.waitingFor && (
                      <small>{waiting.find((item) => item.caseId === row.caseId)!.waitingFor}</small>
                    )}
                    <ContractAttention flags={[...row.flags,...(row.previousPayPending?['pay_pending']:[])]} stalledDays={row.stalledDays} compact/>
                    {row.reconciliationNeeded && row.reconciliationCaseId && (
                      <small>
                        <Link href={'/lifecycle/contracts/' + encodeURIComponent(row.reconciliationCaseId)}>
                          {copy('Open original Contract case')}
                          {row.reconciliationCaseNumber && ' · ' + row.reconciliationCaseNumber}
                        </Link>
                      </small>
                    )}
                    {!row.stage || row.stage === 'open' ? (
                      <small>
                        {row.firstReminderOn
                          ? copy('First reminder due') + ' ' + contractDate(row.firstReminderOn)
                          : copy('No reminder workflows live')}
                      </small>
                    ) : null}
                    {row.previousPayPending && row.payPendingCaseId && (
                      <small>
                        <Link href={'/lifecycle/contracts/' + row.payPendingCaseId}>
                          {copy('Earlier period · Pay confirmation pending')}
                        </Link>
                      </small>
                    )}
                  </td>
                  <td>
                    {row.sourceIssue === 'native_intake_required' ? (
                      <Link className="v9-button" href="/lifecycle/contracts/intake">
                        {copy('Open native intake')}
                      </Link>
                    ) : row.caseId ? (
                      <Link className="v9-button" href={`/lifecycle/contracts/${row.caseId}`}>
                        {copy('Open case')}
                      </Link>
                    ) : (
                      <Link className="v9-button" href={`/lifecycle/contracts/periods/${row.employmentId}`}>
                        {copy('View period')}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!page.rows.length && (
            <p className="v9-empty">
              {copy('No current contract periods match these filters in your permitted scope.')}
            </p>
          )}
        </div>
        <div className="v9-actions">
          <p>
            {page.total
              ? `${page.offset + 1}–${Math.min(page.offset + page.rows.length, page.total)} of ${page.total}`
              : copy('0 periods')}
          </p>
          {page.offset > 0 && (
            <Link className="v9-button" href={href(Math.max(0, page.offset - page.limit))}>
              {copy('Previous')}
            </Link>
          )}
          {page.hasMore && (
            <Link className="v9-button" href={href(page.offset + page.limit)}>
              {copy('Next')}
            </Link>
          )}
        </div>
      </section>
      <p className="v9-muted">
        {copy('An unsigned contract past its end date stays pending. Employment never ends automatically.')}
      </p>
    </div>
  );
}
