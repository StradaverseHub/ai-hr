'use client';
import {ContractFallbackHistory} from '../fallback-history';
import {ContractManualWorkflow} from '../manual-workflow';
import {ContractAttention} from '../attention';
import { useContractSharedCopy } from '@/lib/contract-shared-copy';
import {useContractReasonLabel} from '@/lib/contract-reason-copy';
import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, Circle, AlertCircle } from 'lucide-react';
import type { contractSharedWorkspace, ContractDecisionPreview } from '@/packs/contracts/service';
import type { ContractFlowDecisionDraft } from '@/lib/contract-case-flow';
import { addDaysIso } from '@/lib/roster-month';
import { addCalendarMonths } from '@/lib/hr-date';
import { ContractPostingReceipt } from '../posting-receipt';
import { ContractDecline } from '../record-decline';
import { ContractPeriodHistory } from '../period-history';
import { contractTimestamp } from '../shared';
import {
  previewSharedDecision,
  readSharedDecisionPreview,
  submitSharedDecision,
  adoptSharedCase,
  readSharedEmailReconciliations,
} from '../shared-actions';
import {
  SharedContractNavigation,
  ContractPanel,
  ContractTerms,
  ContractFeedback,
  contractDate,
  contractSalary,
} from '../shared-case-ui';

type Workspace = Awaited<ReturnType<typeof contractSharedWorkspace>>;
type EmailReconciliationPage=NonNullable<Workspace['emailReconciliations']>;
function HistoricalWorkflowReview({caseId,initial}:{caseId:string;initial:EmailReconciliationPage}){
  return <HistoricalWorkflowReviewPage key={JSON.stringify([caseId,initial])} caseId={caseId} initial={initial}/>;
}
function HistoricalWorkflowReviewPage({caseId,initial}:{caseId:string;initial:EmailReconciliationPage}){
  const copy=useContractSharedCopy(),[page,setPage]=useState(initial),[error,setError]=useState(''),[busy,start]=useTransition();
  const alive=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  function more(){
    start(async()=>{setError('');try{
      const result=await readSharedEmailReconciliations(caseId,page.offset+page.limit);
      if(!alive.current)return;
      if(!result.ok){setError(result.error);return;}
      if(result.value.total!==page.total){
        const latest=await readSharedEmailReconciliations(caseId,0);
        if(!alive.current)return;
        if(latest.ok)setPage(latest.value);else setError(latest.error);
        return;
      }
      setPage(previous=>({...result.value,items:[...previous.items,...result.value.items.filter(item=>!previous.items.some(existing=>existing.eventId===item.eventId))]}));
    }catch{if(alive.current)setError('Workflow review records could not be loaded. Your current page is retained; try again.');}});
  }
  if(!page.total)return null;
  return <ContractPanel title={copy('Historical workflow review')}>
    <ContractFeedback error={error}/><p><strong>{copy('Needs People Ops review')}</strong></p>
    <ol className="contract-rail">{page.items.map(item=><li key={item.eventId}><AlertCircle aria-hidden/><div>
      <Link className="v9-prewrap" href={'/lifecycle/contracts/'+encodeURIComponent(item.caseId)}>{copy('Open original Contract case')} · {item.caseNumber}</Link>
      <p>{copy('Review recorded')} {contractTimestamp(item.recordedAt)}</p>
      <p>{copy(item.workflows.length>0&&item.workflows.every(workflow=>workflow.stage==='not_started')?'These workflow versions were not started during email recovery. People Ops must review the original Contract case.':'People Ops must review the original Contract case to establish which workflow steps ran.')}</p>
      <ul className="v9-stack">{item.workflows.map((workflow,index)=><li key={workflow.id+':'+workflow.revision+':'+index}>
        <strong className="v9-prewrap">{workflow.name}</strong> · {copy('Version')} {workflow.revision}
        <p>{copy(workflow.stage==='not_started'?'Not run':'Needs People Ops review')}</p>
      </li>)}</ul>
    </div></li>)}</ol>
    <p className="v9-muted">{page.items.length} {copy('of')} {page.total} {copy('historical review records')}</p>
    {page.hasMore&&<button className="v9-button" disabled={busy} onClick={more}>{busy?copy('Loading…'):copy('Show more workflow reviews')}</button>}
  </ContractPanel>;
}

const stepNames: Record<string, string> = {
  requestApproval: 'Request approval',
  generateDocument: 'Generate letter',
  sendEmail: 'Send email',
  notify: 'Notify recipients',
  createPosting: 'Create Personnel posting',
  startOffboarding: 'Start Offboarding',
};
const stageNames: Record<string, string> = {
  open: 'Decision needed',
  workflow: 'Workflow continuing',
  approval: 'Decision approval',
  document: 'Letter routing',
  posting: 'Personnel posting',
  pay: 'Pay confirmation',
  renewed: 'Renewed',
  converted: 'Converted to permanent',
  offboarding: 'Handed to Offboarding',
  superseded: 'Superseded',
};
const logNames: Record<string, string> = {
  stepDone: 'Completed',
  stepSkipped: 'Skipped',
  waiting: 'Waiting for assigned action',
  stepFailed: 'Needs review',
  failed: 'Needs review',
};
export function SharedContractDetail({
  workspace,
  today,
  caseFiles,
}: {
  workspace: Workspace;
  today: string;
  caseFiles?: ReactNode;
}) {
  const copy = useContractSharedCopy(),reasonLabel=useContractReasonLabel();
  const reviewRunIds=new Set(workspace.emailReconciliations?.items.flatMap(item=>item.retainedRunIds)??[]);
  const displayReasons=[...workspace.reasons,...(workspace.reasonLabels??[])];
  const { view } = workspace,
    flow = view.flow,
    router = useRouter(),
    [busy, start] = useTransition(),
    [error, setError] = useState(''),
    [previewId, setPreviewId] = useState<string | null>(null),
    [preview, setPreview] = useState<ContractDecisionPreview | null>(null),
    [checking, setChecking] = useState(false);
  const startOn = flow ? addDaysIso(flow.period.endOn, 1) : '',
    [draft, setDraft] = useState<ContractFlowDecisionDraft>({
      kind: 'renew',
      months: 12,
      startOn,
      endOn: startOn ? addDaysIso(addCalendarMonths(startOn, 12), -1) : '',
      payChanges: false,
      reason: '',
    });
  useEffect(() => {
    if (!previewId) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    setChecking(true);
    async function poll() {
      try {
        const result = await readSharedDecisionPreview(previewId!);
        if (!active) return;
        if (!result.ok) {
          setError(result.error);
          setChecking(false);
          return;
        }
        setPreview(result.value);
        if (
          ['failed', 'cancelled'].includes(result.value.jobState) ||
          (result.value.jobState === 'completed' && !result.value.plan)
        ) {
          setError('The decision preview stopped. Try the preview again or ask People Ops to review the setup.');
          setChecking(false);
          setPreviewId(null);
          return;
        }
        if (result.value.plan) {
          setChecking(false);
          return;
        }
        timer = setTimeout(poll, 3000);
      } catch {
        if (active) {
          setError('The preview could not be loaded. Try again.');
          setChecking(false);
        }
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [previewId]);
  function update(patch: Partial<ContractFlowDecisionDraft>) {
    setDraft((old) => ({ ...old, ...patch }));
    setPreview(null);
    setPreviewId(null);
    setError('');
  }
  function requestPreview() {
    if (!flow) return;
    start(async () => {
      setError('');
      setPreview(null);
      try {
        const result = await previewSharedDecision({ caseId: view.id, revision: flow.revision, draft });
        if (result.ok) setPreviewId(result.value.previewId);
        else setError(result.error);
      } catch {
        setError('The preview could not be requested. Your entries are still here. Try again.');
      }
    });
  }
  function submit() {
    if (!flow || !preview) return;
    start(async () => {
      setError('');
      try {
        const result = await submitSharedDecision({ caseId: view.id, revision: flow.revision, previewId: preview.id });
        if (result.ok) {
          setPreview(null);
          setPreviewId(null);
          router.refresh();
        } else setError(result.error);
      } catch {
        setError('The decision could not be submitted. Your preview is still here. Try again.');
      }
    });
  }
  const closed = !!flow && ['renewed', 'converted', 'offboarding', 'superseded'].includes(flow.stage),
    periodMatches = view.sourceCurrent && (!flow || flow.period.sourceRevision === view.source.periodRevision),
    ending = flow?.decision?.kind === 'end' || !!flow?.declined;
  const stages: [string, string][] = [
    ['open', 'Decision'],
    ...(workspace.approvals.length ? [['approval', 'Approvals'] as [string, string]] : []),
    ['document', 'Letter'],
    ...(ending
      ? [['offboarding', 'Offboarding handoff'] as [string, string]]
      : [
          ['posting', 'Personnel posting'] as [string, string],
          ...(flow?.decision?.payChanges ? [['pay', 'Pay confirmation'] as [string, string]] : []),
        ]),
    ['closed', 'Closed'],
  ];
  const current = closed ? 'closed' : flow?.stage === 'workflow' ? 'workflow' : flow?.stage;
  useEffect(() => {
    if (!flow || closed || flow.stage === 'open') return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) router.refresh();
    }, 15000);
    return () => clearInterval(timer);
  }, [flow?.revision, flow?.stage, closed, router]);
  return (
    <div className="v9-stack">
      <header className="v9-heading">
        <div>
          <h1>{view.source.name}</h1>
          <p>
            {view.source.employeeId} · {view.source.company} · {view.caseNumber}
          </p>
        </div>
        <Link className="v9-button" href="/lifecycle/contracts">
          {copy('Back to contract cases')}
        </Link>
      </header>
      <SharedContractNavigation />
      <ContractFeedback error={error} />
      {workspace.emailReconciliations&&<HistoricalWorkflowReview caseId={view.id} initial={workspace.emailReconciliations}/>}
      <div className="contract-layout">
        <div className="v9-stack">
          <ContractPanel title={copy('Contract period')}>
            <dl className="contract-facts">
              <div>
                <dt>{copy('Period')}</dt>
                <dd>
                  {copy('Contract #')}
                  {flow?.period.number ?? view.source.contractNumber ?? 'Needs verification'} ·{' '}
                  {contractDate(flow?.period.startOn ?? view.source.startOn)}–
                  {contractDate(flow?.period.endOn ?? view.source.endOn)}
                </dd>
              </div>
              <div>
                <dt>{copy('Direct Superior')}</dt>
                <dd>{view.source.manager || 'Not assigned'}</dd>
              </div>
              <div>
                <dt>{copy('Department / position')}</dt>
                <dd>
                  {view.source.department} · {view.source.designation}
                </dd>
              </div>
              <div>
                <dt>{copy('Current basic salary')}</dt>
                <dd>
                  {view.permissions.includes('seePay') ? contractSalary(view.source.salaryCents) : copy('Restricted')}
                </dd>
              </div>
            </dl>
            {!periodMatches && (
              <p className="v9-notice">
                {copy(
                  'Personnel facts no longer match this case’s recorded period. Retained decisions and letters remain unchanged.',
                )}
              </p>
            )}
          </ContractPanel>
          <ContractAttention flags={[...(flow?.flags??[]),...(workspace.attention?.flags??[])]} stalledDays={workspace.attention?.stalledDays}/>
          {!flow ? (
            <ContractPanel title={copy('Existing contract case')}>
              <p>{copy('Existing approvals, letters and record updates keep their original workflow.')}</p>
              {view.cutoverAvailable && view.permissions.includes('decide') ? (
                <>
                  <p>
                    {copy(
                      'This case has no submitted decision. You can start the shared Contract workflow after reviewing the current Personnel period.',
                    )}
                  </p>
                  <button
                    className="v9-button v9-button-primary"
                    disabled={busy}
                    onClick={() =>
                      start(async () => {
                        const result = await adoptSharedCase(view.id);
                        if (result.ok) router.refresh();
                        else setError(result.error);
                      })
                    }
                  >
                    {copy('Start shared contract workflow')}
                  </button>
                </>
              ) : workspace.legacyReadable ? (
                <Link className="v9-button" href={`/lifecycle/contracts/${view.id}?legacy=1`}>
                  {copy('Open existing workflow')}
                </Link>
              ) : (
                <p>
                  {copy(
                    'Authorised original workflow participants can continue their work. This view shows the retained case and Personnel period.',
                  )}
                </p>
              )}
            </ContractPanel>
          ) : flow.stage === 'open' && periodMatches ? (
            <ContractPanel title={copy('Contract decision')}>
              {view.permissions.includes('decide') ? (
                <>
                  <div className="contract-decision-choice" role="group" aria-label={copy('Decision')}>
                    {(['renew', 'convert', 'end'] as const).map((kind) => (
                      <button
                        key={kind}
                        className={'v9-button' + (draft.kind === kind ? ' v9-button-primary' : '')}
                        aria-pressed={draft.kind === kind}
                        disabled={busy || checking}
                        onClick={() => update({ kind })}
                      >
                        {kind === 'renew'
                          ? copy('Renew')
                          : kind === 'convert'
                            ? copy('Convert to permanent')
                            : copy('End')}
                      </button>
                    ))}
                  </div>
                  {draft.kind !== 'end' ? (
                    <>
                      <div className="contract-facts">
                        {draft.kind === 'renew' && (
                          <label className="v9-field">
                            <span>{copy('Renewal term (months)')}</span>
                            <input
                              className="v9-input"
                              type="number"
                              min={3}
                              max={120}
                              value={draft.months ?? ''}
                              disabled={busy || checking}
                              onChange={(e) => {
                                const months = Number(e.target.value);
                                update({
                                  months,
                                  ...(Number.isInteger(months) && months >= 3 && months <= 120 && draft.startOn
                                    ? { endOn: addDaysIso(addCalendarMonths(draft.startOn, months), -1) }
                                    : {}),
                                });
                              }}
                            />
                          </label>
                        )}
                        <label className="v9-field">
                          <span>{copy('New start date')}</span>
                          <input
                            className="v9-input"
                            type="date"
                            min={startOn}
                            value={draft.startOn ?? ''}
                            disabled={busy || checking}
                            onChange={(e) => update({ startOn: e.target.value })}
                          />
                        </label>
                        {draft.kind === 'renew' && (
                          <label className="v9-field">
                            <span>{copy('New end date')}</span>
                            <input
                              className="v9-input"
                              type="date"
                              value={draft.endOn ?? ''}
                              disabled={busy || checking}
                              onChange={(e) => update({ endOn: e.target.value })}
                            />
                          </label>
                        )}
                      </div>
                      {draft.kind === 'convert' && (
                        <p className="v9-notice">
                          {copy('Conversion has no contract end date and does not open a new probation case.')}
                        </p>
                      )}
                      <label className="v9-actions">
                        <input
                          type="checkbox"
                          checked={draft.payChanges}
                          disabled={busy || checking}
                          onChange={(e) => update({ payChanges: e.target.checked })}
                        />
                        {copy('Pay changes')}
                      </label>
                      {draft.payChanges && (
                        <label className="v9-field">
                          <span>{copy('Proposed basic salary (RM)')}</span>
                          <input
                            className="v9-input"
                            inputMode="decimal"
                            value={draft.basicSalary ?? ''}
                            disabled={busy || checking}
                            onChange={(e) => update({ basicSalary: e.target.value })}
                          />
                          <small>
                            {copy(
                              'Payroll is updated separately and manually after the Personnel posting is approved.',
                            )}
                          </small>
                        </label>
                      )}
                    </>
                  ) : (
                    <>
                      <p>
                        {copy('Last working day: ')}
                        <strong>{contractDate(flow.period.endOn)}</strong>
                        {copy('. A released outcome letter precedes the Offboarding handoff.')}
                      </p>
                      <label className="v9-field">
                        <span>{copy('Reason for ending')}</span>
                        <select
                          value={draft.endReason ?? ''}
                          disabled={busy || checking}
                          onChange={(e) => update({ endReason: e.target.value })}
                        >
                          <option value="">{copy('Choose a Personnel Management reason')}</option>
                          {workspace.reasons.map((reason) => (
                            <option key={reason.code} value={reason.code}>
                              {reasonLabel(reason.code,reason.label)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                  <label className="v9-field">
                    <span>{draft.kind === 'end' ? copy('Notes (optional)') : copy('Reason for decision')}</span>
                    <textarea
                      rows={4}
                      maxLength={5000}
                      value={draft.reason}
                      disabled={busy || checking}
                      onChange={(e) => update({ reason: e.target.value })}
                    />
                  </label>
                  <button
                    className="v9-button v9-button-primary"
                    disabled={busy || checking}
                    aria-busy={busy || checking}
                    onClick={requestPreview}
                  >
                    {checking ? copy('Preparing decision preview…') : copy('Preview decision')}
                  </button>
                  {checking && (
                    <button
                      className="v9-button"
                      onClick={() => {
                        setPreviewId(null);
                        setChecking(false);
                        setPreview(null);
                      }}
                    >
                      {copy('Back to editing')}
                    </button>
                  )}
                </>
              ) : (
                <p>{copy('Your role can view this case. The assigned decision owner can submit a decision.')}</p>
              )}
            </ContractPanel>
          ) : flow.decision ? (
            <ContractPanel title={copy('Submitted decision')}>
              <ContractTerms decision={flow.decision} reasons={displayReasons} />
              <p className="v9-muted">
                {copy('Submitted ')}
                {contractDate(flow.decision.submittedAt)} {copy(' · Decision revision ')}
                {flow.decision.revision}
                {copy('. These terms stay fixed while approval and signing continue.')}
              </p>
            </ContractPanel>
          ) : null}
          {preview?.plan && (
            <ContractPanel title={copy('Review decision before submitting')}>
              <ContractTerms decision={preview.decision} reasons={displayReasons} />
              {preview.plan.blockers.length > 0 && (
                <div className="v9-notice v9-error" role="alert">
                  <strong>{copy('Resolve before submitting')}</strong>
                  <ul>
                    {preview.plan.blockers.map((text, i) => (
                      <li key={i}>{text}</li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.plan.warnings.length > 0 && (
                <div className="v9-notice">
                  <strong>{copy('Review these consequences')}</strong>
                  <ul>
                    {preview.plan.warnings.map((text, i) => (
                      <li key={i}>{text}</li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.plan.workflows.map((workflow) => (
                <section className="v9-stack" key={workflow.id}>
                  <h3>
                    {workflow.name} {copy(' · Version ')}
                    {workflow.revision}
                  </h3>
                  <ol className="contract-rail">
                    {workflow.steps.map((step) => (
                      <li key={step.id}>
                        <Circle aria-hidden />
                        <div>
                          <strong>{step.label}</strong>
                          {step.to.length > 0 && (
                            <p>
                              {copy('To: ')}
                              {step.to.join(', ')}
                            </p>
                          )}
                          {step.cc.length > 0 && (
                            <p>
                              {copy('CC: ')}
                              {step.cc.join(', ')}
                            </p>
                          )}
                          {step.layers.map((layer) => (
                            <p key={layer.id}>
                              {layer.name} · {layer.who} ·{' '}
                              {layer.pick === 'any' ? copy('Any eligible member') : copy('Round robin')}
                            </p>
                          ))}
                          {step.letter && (
                            <>
                              <p>
                                {step.letter.name} {copy(' · Template version ')}
                                {step.letter.version}
                              </p>
                              {step.letter.steps.map((layer, i) => (
                                <p key={i}>
                                  {layer.label} · {layer.action} · {layer.who}
                                  {layer.owner ? copy(' · Owner') : ''}
                                </p>
                              ))}
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
              <div className="v9-actions">
                <button
                  className="v9-button v9-button-primary"
                  disabled={busy || preview.plan.blockers.length > 0}
                  onClick={submit}
                >
                  {copy('Submit decision')}
                </button>
                <button
                  className="v9-button"
                  disabled={busy}
                  onClick={() => {
                    setPreview(null);
                    setPreviewId(null);
                  }}
                >
                  {copy('Back to editing')}
                </button>
              </div>
            </ContractPanel>
          )}
          {flow && flow.stage !== 'open' && (
            <ContractPanel title={copy('Case progress')}>
              {flow.stage === 'workflow' && (
                <p role="status" aria-current="step">
                  {copy('Workflow continuing')}
                </p>
              )}
              <ol className="contract-progress">
                {stages.map(([id, label]) => (
                  <li key={id} aria-current={current === id ? 'step' : undefined}>
                    {copy(label)}
                    {current === id ? copy(' · Current') : ''}
                  </li>
                ))}
              </ol>
              {flow.stage === 'pay' && (
                <>
                  <p>
                    {copy(
                      'The Personnel posting was approved. The case remains open until an authorised posting approver confirms that Payroll was updated manually.',
                    )}
                  </p>
                  <Link className="v9-button" href={'/lifecycle/contracts/postings?status=approved'+(workspace.postingSummary?.postingId||flow.posting?.id?'&postingId='+encodeURIComponent(workspace.postingSummary?.postingId??flow.posting!.id):'')}>
                    {copy('Review posting and pay confirmation')}
                  </Link>
                </>
              )}
              {flow.stage === 'offboarding' && (
                <>
                  <p>
                    {copy('Handed to Offboarding. Last day ')}
                    {contractDate(flow.period.endOn)}
                    {copy(
                      '. People Ops records termination manually in Personnel Management until clearance is available.',
                    )}
                  </p>
                  {flow.offboardingId && (
                    <Link className="v9-button" href={`/lifecycle/v9?view=leavers&case=${flow.offboardingId}`}>
                      {copy('Open Offboarding case')}
                    </Link>
                  )}
                </>
              )}
              {closed && flow.stage !== 'offboarding' && (
                <p>
                  {flow.stage === 'superseded'
                    ? copy('This period was superseded by a verified Personnel change.')
                    : copy('This case is closed.')}
                </p>
              )}
            </ContractPanel>
          )}
          {workspace.postingSummary && (
            <ContractPostingReceipt
              caseId={view.id}
              summary={workspace.postingSummary}
              today={today}
              payChanges={!!flow?.decision?.payChanges}
            />
          )}
          {flow && workspace.ending?.canRecordDecline && (
            <ContractDecline caseId={view.id} revision={flow.revision} reasons={workspace.reasons} />
          )}
          {workspace.approvals.length > 0 && (
            <ContractPanel title={copy('Decision approvals')}>
              <ul className="contract-rail">
                {workspace.approvals.map((item) => (
                  <li key={item.id}>
                    {item.status === 'approved' ? (
                      <CheckCircle2 aria-hidden />
                    ) : item.status === 'rejected' ? (
                      <AlertCircle aria-hidden />
                    ) : (
                      <Circle aria-hidden />
                    )}
                    <div>
                      <strong>{item.workflowName}</strong>
                      <p>
                        {copy('Decision revision ')}
                        {item.decisionRevision} · {item.status}
                      </p>
                      <Link href={`/lifecycle/contracts/approvals/${item.id}`}>{copy('Review approval')}</Link>
                    </div>
                  </li>
                ))}
              </ul>
            </ContractPanel>
          )}
          <ContractPanel title={copy('Letters')}>
            {workspace.letters.length ? (
              <ul className="contract-rail">
                {workspace.letters.map((item) => (
                  <li key={item.id}>
                    {item.state === 'released' ? (
                      <CheckCircle2 aria-hidden />
                    ) : item.returned ? (
                      <AlertCircle aria-hidden />
                    ) : (
                      <Circle aria-hidden />
                    )}
                    <div>
                      <strong>{item.name}</strong>
                      <p>
                        {copy('Template version ')}
                        {item.templateVersion} · {item.returned ? copy('Sent back') : item.state}{' '}
                        {copy(' · Decision revision ')}
                        {item.decisionRevision}
                      </p>
                      <Link href={`/lifecycle/contracts/letters/${item.id}`}>{copy('Open letter and routing')}</Link>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="v9-muted">{copy('Letters appear when a workflow generates them.')}</p>
            )}
          </ContractPanel>
          {workspace.fallbackPage&&<ContractFallbackHistory caseId={view.id} initial={workspace.fallbackPage}/>}
          {caseFiles}
          {flow&&view.permissions.includes('manual')&&<ContractManualWorkflow caseId={view.id} revision={flow.revision}/>}
          {workspace.runs.length > 0 && (
            <ContractPanel title={copy('Workflow progress')}>
              {workspace.runs.map((run) => (
                <section className="v9-stack" key={run.id}>
                  <h3>
                    {run.name} {copy(' · Version ')}
                    {run.revision}
                  </h3>
                  <p>
                    {run.status === 'failed' || reviewRunIds.has(run.id)
                      ? copy('Needs People Ops review')
                      : run.status === 'waiting'
                        ? copy('Waiting for assigned action')
                        : run.status === 'done'
                          ? copy('Completed')
                          : run.status === 'skipped'
                            ? copy('Skipped by workflow conditions')
                            : copy('Running')}
                  </p>
                  <ol className="contract-rail">
                    {run.steps.map((step, index) => {
                      const entry = run.log.filter((l) => l.stepId === step.id).at(-1);
                      const stepStatus=run.status==='failed'
                        ?entry?.kind==='stepDone'?'Completed':entry?.kind==='stepSkipped'?'Skipped':entry||index<run.cursor?'Needs review':'Not run'
                        :entry?.kind?(logNames[entry.kind]??entry.kind):index<run.cursor?'Completed':'Waiting';
                      return (
                        <li key={step.id}>
                          {entry?.kind === 'stepDone' ? <CheckCircle2 aria-hidden /> : <Circle aria-hidden />}
                          <div>
                            <strong>{copy(stepNames[step.type] ?? step.name)}</strong>
                            <p>
                              {copy(stepStatus)}
                            </p>
                            {entry?.message&&<p>{entry.message}</p>}
                            {!!entry?.fallbackCount&&<p className="v9-notice">{copy('Recipient routing needs review for this step.')} {entry.fallbackCount} {copy('recipient choices could not be resolved. Check the step routing in HR Automation.')}</p>}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </ContractPanel>
          )}
          <ContractPeriodHistory caseId={view.id} initial={workspace.periods} />
          {workspace.activity.length > 0 && (
            <ContractPanel title={copy('Recent case activity')}>
              <ol className="contract-rail">
                {workspace.activity.map((item) => (
                  <li key={item.revision}>
                    <CheckCircle2 aria-hidden />
                    <div>
                      <strong>
                        {item.actorName ||
                          (item.actorType === 'system' ? copy('System') : copy('Recorded authorised actor'))}
                      </strong>
                      <p>
                        {copy('Case revision')} {item.revision} · {copy(stageNames[item.stage] ?? item.stage)}
                      </p>
                      <small>{contractTimestamp(item.at)}</small>
                    </div>
                  </li>
                ))}
              </ol>
              {workspace.activity.length === 50 && (
                <p className="v9-muted">{copy('Showing the latest 50 case changes.')}</p>
              )}
            </ContractPanel>
          )}
        </div>
        <aside className="v9-stack">
          <ContractPanel title={copy('Case ownership')}>
            {workspace.configuredFallbackGroup&&<p>{copy('Current fallback group:')} <strong>{workspace.configuredFallbackGroup}</strong></p>}
            {workspace.waiting && (
              <p>
                <strong>{workspace.waiting.waitingOn}</strong>
                <br />
                {workspace.waiting.waitingFor}
              </p>
            )}
            {flow?.stage === 'workflow' && (
              <p role="status">{copy('The workflow is continuing. Progress refreshes while this page is visible.')}</p>
            )}
            <p>{copy('Decision: Direct Superior or authorised Contract decision owner.')}</p>
            <p>{copy('Approval and letter actions: the current assigned layer.')}</p>
            <p>{copy('Personnel posting and manual pay confirmation: Contract posting approver group.')}</p>
            <p className="v9-muted">{copy('An unsigned or overdue contract never ends employment automatically.')}</p>
          </ContractPanel>
          <ContractPanel title={copy('Source and history')}>
            <p>{copy('Personnel Management owns employment dates, type and contract number. Payroll owns pay.')}</p>
            <p>
              {copy('Business date: ')}
              {contractDate(today)}
            </p>
            {workspace.canOpenPersonnel && (
              <Link href={`/admin/personnel/${view.employmentId}`}>{copy('Open Personnel record')}</Link>
            )}
          </ContractPanel>
        </aside>
      </div>
    </div>
  );
}
