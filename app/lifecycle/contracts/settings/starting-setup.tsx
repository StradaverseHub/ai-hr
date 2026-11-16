'use client';
import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ContractSharedSetup } from '@/packs/contracts/service';
import { useContractSharedCopy } from '@/lib/contract-shared-copy';
import { ContractPanel, ContractFeedback } from '../shared-case-ui';
import { startSharedSetup, readSharedSetup } from '../shared-actions';
export function ContractStartingSetup({
  initial,
  companyId,
  fallbackGroupId,
  postingApproverGroupId,
}: {
  initial: ContractSharedSetup;
  companyId: string;
  fallbackGroupId: string;
  postingApproverGroupId: string;
}) {
  const copy = useContractSharedCopy(),
    router = useRouter(),
    [setup, setSetup] = useState(initial),
    [mapping, setMapping] = useState({
      companyId,
      fallbackGroupId,
      postingApproverGroupId,
      bpRoutingId: '',
      ceoRoutingId: '',
    }),
    [error, setError] = useState(''),
    [busy, start] = useTransition();
  useEffect(() => {
    if (!setup.jobId || setup.installed) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await readSharedSetup(companyId);
        if (!active) return;
        if (!result.ok) {
          setError(result.error);
          return;
        }
        if (['failed', 'cancelled', 'completed'].includes(result.value.jobState ?? '') && !result.value.installed) {
          setSetup({ ...result.value, jobId: null });
          setError(
            'The starting configuration stopped before completion. Review the mapped groups, routings and permissions, then install again. Existing definitions are preserved.',
          );
          return;
        }
        setError('');
        setSetup(result.value);
        if (result.value.installed) {
          router.refresh();
          return;
        }
        if (result.value.jobId) timer = setTimeout(poll, 3000);
      } catch {
        if (active) {
          setError('Installation status could not be read. Retrying…');
          timer = setTimeout(poll, 10000);
        }
      }
    }
    timer = setTimeout(poll, 1500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [setup.jobId, setup.installed, companyId, router]);
  function install() {
    start(async () => {
      setError('');
      try {
        const result = await startSharedSetup(mapping);
        if (result.ok) setSetup({ ...setup, jobId: result.value.jobId });
        else setError(result.error);
      } catch {
        setError('The installation could not be started. Try again.');
      }
    });
  }
  function group(label: string, key: 'fallbackGroupId' | 'postingApproverGroupId') {
    return (
      <label className="v9-field">
        <span>{copy(label)}</span>
        <select
          value={mapping[key]}
          disabled={busy || !!setup.jobId}
          onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })}
        >
          <option value="">{copy('Choose an existing populated group')}</option>
          {setup.groups.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
    );
  }
  function routing(label: string, key: 'bpRoutingId' | 'ceoRoutingId') {
    return (
      <label className="v9-field">
        <span>{copy(label)}</span>
        <select
          value={mapping[key]}
          disabled={busy || !!setup.jobId}
          onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })}
        >
          <option value="">{copy('Choose an existing routing')}</option>
          {setup.routings.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <ContractPanel title={copy('Starting configuration')}>
      <ContractFeedback error={error} />
      {setup.installed ? (
        <p>
          {copy(
            'The shared Contract starting configuration is installed. Manage its workflows, templates and routing in HR Automation. Existing custom definitions are preserved.',
          )}
        </p>
      ) : (
        <>
          <p>
            {copy(
              'Map real teams and routings before installing the reviewed starting configuration. No placeholder people or assignment groups are created.',
            )}
          </p>
          {!setup.v9Ready && (
            <p className="v9-notice">
              {copy(
                'Shared lifecycle configuration needs initialization by an authorised HR Automation administrator before groups can be mapped.',
              )}
            </p>
          )}
          {setup.missing.length > 0 && (
            <ul>
              {setup.missing.map((message, index) => (
                <li key={index}>{message}</li>
              ))}
            </ul>
          )}
          {setup.canInstall ? (
            <>
              <div className="contract-facts">
                {group('Fallback / People Ops group', 'fallbackGroupId')}
                {group('Personnel posting approver group', 'postingApproverGroupId')}
                {routing('People BP letter-signing routing', 'bpRoutingId')}
                {routing('CEO decision-approval routing', 'ceoRoutingId')}
              </div>
              <p className="v9-muted">
                {copy(
                  'The starting templates and workflows are shared. Choose routings that cover the companies where they will run. Later edits in HR Automation affect new runs only.',
                )}
              </p>
              <button
                className="v9-button v9-button-primary"
                disabled={busy || !!setup.jobId || Object.values(mapping).some((value) => !value)}
                aria-busy={busy || !!setup.jobId}
                onClick={install}
              >
                {setup.jobId ? copy('Installing starting configuration…') : copy('Install starting configuration')}
              </button>
            </>
          ) : (
            <p className="v9-muted">
              {copy('Installation requires Contract settings, workflow and template administration permissions.')}
            </p>
          )}
        </>
      )}
      <Link href="/automation">{copy('Open HR Automation')}</Link>
    </ContractPanel>
  );
}
