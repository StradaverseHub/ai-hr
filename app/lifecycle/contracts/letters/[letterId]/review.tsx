'use client';
import { useContractSharedCopy } from '@/lib/contract-shared-copy';
import Link from 'next/link';
import { derivedDocumentKind } from '@/lib/document-form-fields';
import { useEffect, useRef, useState, useTransition } from 'react';
import { CheckCircle2, Circle, AlertCircle } from 'lucide-react';
import type { ContractSharedLetter,ContractSharedForm,ContractSharedReleaseProof } from '@/packs/contracts/service';
import type { Document } from '@/lib/lifecycle-v9-model';
import { DocumentBody } from '@/components/lifecycle-v9/document-body';
import {contractDocumentWordingFields,contractWordingKeys,contractWordingLabels,contractUnknownFields} from '@/lib/contract-letter-wording';
import {ContractRecordedSignatures} from '../../recorded-signatures';
import {ContractFormResponse} from '../../form-response';
import { ContractSignature } from '../../signature';
import { actSharedLetter, editSharedLetter, bindSharedEmployee,saveSharedForm,readSharedLetterState } from '../../shared-actions';
import { contractTimestamp } from '../../shared';
import { ContractPanel, ContractFeedback, contractDate } from '../../shared-case-ui';

export function SharedLetterPage({
  letter: initial,
  document: initialDocument,
  capabilities: initialCapabilities = { canBindEmployee: false },
  form:initialForm=null,releaseProof:initialReleaseProof=null,
}: {
  letter: ContractSharedLetter;
  document: Document | null;
  form?:ContractSharedForm;releaseProof?:ContractSharedReleaseProof|null;
  capabilities?: { canBindEmployee: boolean; canSelfBind?:boolean;companyActionsAvailable?:boolean; purpose?:'outcome'|'declined'|'email';contractDeclineGuidance?:boolean; pendingRole?: 'employee' | 'company' | null };
}) {
  const copy = useContractSharedCopy();
  const [letter, setLetter] = useState(initial),
    [document, setDocument] = useState(initialDocument),
    [capabilities, setCapabilities] = useState(initialCapabilities),
    [form,setForm]=useState<ContractSharedForm>(initialForm),
    [formValues,setFormValues]=useState<Record<string,string>>(initialForm?.visible?initialForm.values:{}),
    [releaseProof,setReleaseProof]=useState(initialReleaseProof),
    [comment, setComment] = useState(''),
    [editing, setEditing] = useState(false),
    [blocks, setBlocks] = useState<Record<string, string>>({}),
    [error, setError] = useState(''),
    [status, setStatus] = useState(''),
    [busy, start] = useTransition();
  const actionsAvailable=capabilities.companyActionsAvailable!==false;
  const wordingFields=contractDocumentWordingFields(document,Object.keys(letter.body?.values??{}),!letter.valuesFixed);
  const wordingRefs=useRef<Record<string,HTMLTextAreaElement|null>>({});
  const activeWording=useRef<{id:string;start:number;end:number}|null>(null);
  const drafting=useRef(false);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  type Result = Awaited<ReturnType<typeof actSharedLetter>>;
  function execute(work: () => Promise<Result>, message: string) {
    start(async () => {
      setError('');
      setStatus('');
      try {
        const response = await work();
        if (!response.ok) {
          setError(response.error);
          return;
        }
        setLetter(response.value.letter);
        setDocument(response.value.document);
        setCapabilities(response.value.capabilities ?? { canBindEmployee: false });
        setForm(response.value.form??null);setFormValues(response.value.form?.visible?response.value.form.values:{});setReleaseProof(response.value.releaseProof??null);
        setEditing(false);
        setBlocks({});
        setComment('');
        setStatus(message);
        attempt.current = null;
      } catch {
        setError('The action could not be completed. Your entries are still here. Try again.');
      }
    });
  }
  function act(
    action: 'signed' | 'reviewed' | 'approved' | 'returned' | 'resent',
    signature?: { method: 'typed' | 'drawn'; value: string; consent: true },
  ) {
    if (!letter.contentHash) return;
    const step = action === 'resent' ? letter.layers.find((l) => l.owner)?.id : letter.pendingAction?.stepId;
    if (!step) return;
    const patch =
      dirty && kind!=='Form' && ['reviewed', 'approved'].includes(action)
        ? Object.fromEntries(Object.entries(blocks).map(([key,value])=>[key,contractWordingKeys(value,wordingFields)]).filter(([key,value])=>contractWordingKeys(letter.body?.blocks[key]??'',wordingFields)!==value))
        : undefined;
    const payload = {
        id: letter.id,
        stepId: step,
        revision: letter.contentRevision,
        hash: letter.contentHash!,
        action,
        comment,
        ...signature,
        ...(form?.visible?{responseRevision:form.responseRevision,responseHash:form.responseHash}:{}),
        ...(patch ? { blocks: patch } : {}),
      },
      key = JSON.stringify(payload);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    execute(
      () => actSharedLetter({ ...payload, actionId: attempt.current!.id }),
      action === 'returned'
        ? 'Letter sent back to its owner.'
        : action === 'resent'
          ? 'Letter resent to its routing steps.'
          : 'Your action was recorded.',
    );
  }
  const kind = form?.kind??(letter.body ? derivedDocumentKind(letter.body.definition.blocks) : null),
    formHeld = kind === 'Form'&&!form?.visible,
    formDirty=!!form?.visible&&Object.entries(formValues).some(([id,value])=>form.values[id]!==value),
    formMissing=form?.visible?(document?.fields??[]).filter(field=>form.editableFieldIds.includes(field.id)&&(!field.when||formValues[field.when.field]===field.when.value)&&field.required&&(!(formValues[field.id]??'').trim()||field.type==='checkbox'&&formValues[field.id]!=='true'||field.type==='table'&&formValues[field.id]==='[]')).map(field=>field.label):[],
    formReady=kind!=='Form'||!!form?.visible&&!formDirty&&!formMissing.length&&!form.missingLockedFields.length&&form.legalBaseHash===letter.contentHash,
    pending = letter.pendingAction,
    wording =
      letter.body?.definition.blocks.filter((b) => ['heading', 'subheading', 'text', 'table'].includes(b.type)) ?? [],
    dirty = Object.entries(blocks).some(([key,value])=>contractWordingKeys(letter.body?.blocks[key]??'',wordingFields)!==contractWordingKeys(value,wordingFields)),
    unknown=contractUnknownFields(editing?Object.values(blocks):Object.values(letter.body?.blocks??{}),Object.keys(letter.body?.values??{}),wordingFields),
    lastSign=!!pending&&pending.kind==='sign'&&letter.layers.every(layer=>layer.fulfilled||layer.id===pending.stepId);
  drafting.current=editing||formDirty;
  function insertField(key:string){
    const target=activeWording.current;if(!target){setStatus(copy('Click into a wording box first.'));return;}
    const value='{'+wordingFields.find(field=>field.key===key)!.label+'}',cursor=target.start+value.length;
    setBlocks(previous=>{const text=previous[target.id]??'';return {...previous,[target.id]:text.slice(0,target.start)+value+text.slice(target.end)};});
    activeWording.current={id:target.id,start:cursor,end:cursor};
    requestAnimationFrame(()=>{const input=wordingRefs.current[target.id];input?.focus();input?.setSelectionRange(cursor,cursor);});
  }
  function refreshLetter(discardAnswers=false){
    if(busy||editing||formDirty&&!discardAnswers)return;
    start(async()=>{setError('');try{
      const result=await readSharedLetterState(letter.id);if(!discardAnswers&&drafting.current)return;
      if(!result.ok){setError(result.error);return;}const next=result.value;
      if(next.letter.contentHash!==letter.contentHash)setStatus('The letter values changed. Review this version before continuing.');
      setLetter(next.letter);setDocument(next.document);setCapabilities(next.capabilities);setForm(next.form);setFormValues(next.form?.visible?next.form.values:{});setReleaseProof(next.releaseProof);
    }catch{setError('The letter could not be refreshed. Your current entries are retained.');}});
  }
  useEffect(()=>{if(letter.state!=='routing'||editing||formDirty||busy)return;const timer=setInterval(()=>{if(documentVisibility()&&navigator.onLine)refreshLetter();},15000);return()=>clearInterval(timer);},[letter.id,letter.contentHash,letter.state,editing,formDirty,busy]);
  function saveAnswers(){if(!form?.visible||!letter.contentHash)return;const current=form;start(async()=>{setError('');try{const result=await saveSharedForm({id:letter.id,contentRevision:letter.contentRevision,contentHash:letter.contentHash!,responseRevision:current.responseRevision,responseHash:current.responseHash,values:Object.fromEntries(Object.entries(formValues).filter(([id,value])=>current.values[id]!==value))});if(result.ok){setForm(result.value);setFormValues(result.value?.visible?result.value.values:{});setStatus('Form answers saved. Review them before completing this step.');}else setError(result.error);}catch{setError('The answers could not be confirmed. Your entries are retained; try again.');}});}
  return (
    <div className="v9-stack">
      <header className="v9-heading">
        <div>
          <h1>{letter.name}</h1>
          <p>
            {copy('Template version ')}
            {letter.templateVersion} {copy(' · Decision revision ')}
            {letter.decisionRevision}
          </p>
        </div>
        <Link
          className="v9-button"
          href={letter.pendingAction?.kind === 'sign'||capabilities.canSelfBind ? '/tasks' : '/approvals?category=contracts'}
        >
          {copy(letter.pendingAction?.kind === 'sign'||capabilities.canSelfBind ? 'My tasks' : 'Approval Items')}
        </Link>
      </header>
      <ContractFeedback error={error} status={status} />
      {letter.state==='routing'&&!actionsAvailable&&<p className="v9-notice">{copy('Contract actions are unavailable for this company. You can still view this retained document.')}</p>}
      <div className="v9-actions"><button type="button" className="v9-button" disabled={busy||editing||formDirty} onClick={()=>refreshLetter()}>{copy('Refresh letter values')}</button></div>
      {releaseProof&&<ContractPanel title={copy('Released document proof')}><p>{copy('Released')} {contractTimestamp(releaseProof.releasedAt)} · {copy('Content revision')} {releaseProof.contentRevision}</p><p>{copy('This fingerprint identifies the retained letter, values and recorded signers.')}</p><code style={{overflowWrap:'anywhere'}}>{releaseProof.fingerprint}</code></ContractPanel>}
      {unknown.length>0&&<div className="v9-notice" role="status">{unknown.map(field=><p key={field}>{copy('Unknown field')} {field}. {copy('It stays as typed.')}</p>)}</div>}
      <div className="contract-layout">
        <div className="v9-stack">
          {formHeld && (
            <p className="v9-notice">
              {copy(capabilities.canSelfBind?'Confirm your account below to open your assigned Form. Your answers stay unavailable until your identity is linked to its routing.':'This Form is not available to your current routing step. Its authorised owner must prepare it before you can continue.')}
            </p>
          )}
          {letter.state === 'routing' && letter.layers.some((layer) => !layer.fulfilled && layer.unavailable) && (
            <p className="v9-notice">
              {copy(
                'A required linked account is unavailable. Routing stays held. Access administration can review restoring the original assigned identity; an unlinked employee must use their own verified account. Completed signatures stay fixed.',
              )}
            </p>
          )}
          {letter.returned && (
            <p className="v9-notice">
              {copy(
                'This letter was sent back. Its owner must review the reason and resend it before routing continues.',
              )}
            </p>
          )}
          {letter.valuesFixed ? (
            <p className="v9-muted">
              {copy(
                'Personnel values were fixed at the first signature or release. Later Personnel changes do not change this letter.',
              )}
            </p>
          ) : (
            <p className="v9-muted">
              {copy(
                'Personnel values stay live until the first signature or release. Review this version before acting.',
              )}
            </p>
          )}
          {document && !formHeld ? (
            <>
              <div className="v9-actions">
                <a className="v9-button" href={`/lifecycle/contracts/letters/${letter.id}/pdf`}>
                  {copy('Download PDF')}
                </a>
                {letter.canEdit && actionsAvailable && !formHeld && !editing && (
                  <button
                    className="v9-button"
                    disabled={busy}
                    onClick={() => {
                      setBlocks(Object.fromEntries(Object.entries(letter.body!.blocks).map(([key,value])=>[key,contractWordingLabels(value,wordingFields)])));
                      setEditing(true);
                    }}
                  >
                    {copy('Edit wording for this case')}
                  </button>
                )}
              </div>
              {editing ? (
                <ContractPanel title={copy('Edit wording for this case')}>
                  <p>
                    {copy('Edits affect this case only. The template, merged Personnel fields and routing stay fixed.')}
                  </p>
                  <label className="v9-field"><span>{copy('Insert merge field')}</span><select defaultValue="" disabled={busy} onChange={event=>{if(event.target.value)insertField(event.target.value);event.target.value='';}}><option value="">{copy('Click into a wording box, then choose a field')}</option>{wordingFields.map(field=><option key={field.key} value={field.key}>{copy(field.group==='This Form'?'This Form':field.group)} · {field.label}</option>)}</select></label>
                  <p className="v9-muted">{copy('Field names stay linked to Personnel values. Table rows use one line per row, with cells separated by |.')}</p>
                  <div className="v9-stack contract-wording">
                    {wording.map((block) => (
                      <div className="v9-field" key={block.id}>
                        <label htmlFor={'contract-wording-'+block.id}>
                        <span>
                          {block.type === 'table'
                            ? copy('Table rows')
                            : block.type === 'heading'
                              ? copy('Heading')
                              : block.type === 'subheading'
                                ? copy('Subheading')
                                : copy('Letter text')}
                        </span></label>
                        <textarea id={'contract-wording-'+block.id}
                          ref={input=>{wordingRefs.current[block.id]=input;}}
                          disabled={busy}
                          value={blocks[block.id] ?? ''}
                          maxLength={1048576}
                          onSelect={event=>{const input=event.currentTarget;activeWording.current={id:block.id,start:input.selectionStart,end:input.selectionEnd};}}
                          onFocus={event=>{const input=event.currentTarget;activeWording.current={id:block.id,start:input.selectionStart,end:input.selectionEnd};}}
                          onChange={(e) => setBlocks((previous) => ({ ...previous, [block.id]: e.target.value }))}
                        />
                        <button type="button" className="v9-button" disabled={busy} onClick={()=>setBlocks(previous=>({...previous,[block.id]:contractWordingLabels(block.type==='table'?block.rows??'':block.text,wordingFields)}))}>{copy('Restore template wording')}</button>
                      </div>
                    ))}
                  </div>
                  <div className="v9-actions">
                    {(kind==='Form'||!['review', 'approve'].includes(pending?.kind ?? '')) && (
                      <button
                        className="v9-button v9-button-primary"
                        disabled={busy || !dirty}
                        onClick={() =>
                          execute(
                            () =>
                              editSharedLetter({
                                id: letter.id,
                                revision: letter.contentRevision,
                                hash: letter.contentHash!,
                                blocks: Object.fromEntries(
                                  Object.entries(blocks).map(([key,value])=>[key,contractWordingKeys(value,wordingFields)]).filter(([key,value])=>contractWordingKeys(letter.body?.blocks[key]??'',wordingFields)!==value),
                                ),
                              }),
                            'Wording saved. Review the updated letter before continuing.',
                          )
                        }
                      >
                        {copy('Save wording')}
                      </button>
                    )}
                    {kind!=='Form'&&['review', 'approve'].includes(pending?.kind ?? '') && (
                      <p className="v9-muted">
                        {copy('Your wording changes are saved together with completing this review.')}
                      </p>
                    )}
                    <button
                      className="v9-button"
                      disabled={busy}
                      onClick={() => {
                        setEditing(false);
                        setBlocks({});
                      }}
                    >
                      {copy('Cancel')}
                    </button>
                  </div>
                </ContractPanel>
              ) : (
                kind==='Form'&&form?.visible?<ContractFormResponse form={form} document={document} values={formValues} busy={busy||!actionsAvailable} dirty={formDirty} missing={formMissing} history={letter.history} change={(id,value)=>setFormValues(previous=>({...previous,[id]:value}))} save={saveAnswers} discard={()=>refreshLetter(true)}/>:<DocumentBody document={document} disabled />
              )}
            </>
          ) : (
            <p className="v9-notice">
              {copy(
                'The letter body becomes available when your routing step is active. The routing summary is shown here.',
              )}
            </p>
          )}
          {document&&!formHeld&&<ContractRecordedSignatures letter={letter}/>}
          {letter.state === 'routing' && actionsAvailable && !formHeld && (pending || letter.canResend) && (
            <ContractPanel title={letter.canResend ? 'Owner review and resend' : 'Your action'}>
              {pending?.kind === 'sign' && (
                <>
                  <p>
                    {copy('Verified AIHR login:')}{' '}
                    <strong>{letter.layers.find((layer) => layer.id === pending.stepId)?.assigneeName}</strong> ·{' '}
                    {copy(capabilities.pendingRole === 'employee' ? 'Employee' : 'Assigned company signatory')}
                  </p>
                  <p className="v9-muted">
                    {copy(
                      'Your verified name, role, date, time and this document version’s fingerprint are saved with your signature.',
                    )}
                  </p>
                </>
              )}
              {pending?.kind==='sign'&&capabilities.pendingRole==='employee'&&<div className="v9-notice"><p>{copy('Signing means you accept the terms of this letter.')}</p><p>{copy(capabilities.contractDeclineGuidance?'To decline, tell your People BP. They will record it in Contract Management.':'Contact your People BP before signing if you need to decline or discuss this document.')}</p></div>}
              <label className="v9-field">
                <span>{copy('Comment / reason for sending back')}</span>
                <textarea
                  rows={3}
                  maxLength={5000}
                  disabled={busy}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
              </label>
              {letter.canResend ? (
                <button className="v9-button v9-button-primary" disabled={busy||!formReady||editing} onClick={() => act('resent')}>
                  {copy('Resend letter')}
                </button>
              ) : pending?.kind === 'sign' ? (
                <ContractSignature
                  key={letter.id + ':' + pending.stepId + ':' + letter.contentRevision + ':' + letter.contentHash+':'+(form?.visible?form.responseHash:'')}
                  signerName={letter.layers.find((layer) => layer.id === pending.stepId)?.assigneeName ?? undefined}
                  busy={busy || editing || !formReady}
                  submitLabel={
                    kind === 'Acknowledgement'
                      ? copy(lastSign?'Acknowledge, sign and release letter':'Acknowledge and sign')
                      : lastSign?copy('Sign and release letter')
                      : capabilities.pendingRole === 'company'
                        ? copy('Sign letter')
                        : undefined
                  }
                  consentLabel={
                    kind === 'Acknowledgement'
                      ? copy('I confirm this is my signature and acknowledge this document.')
                      : capabilities.pendingRole === 'company'
                        ? copy('I confirm this is my signature and approve this letter on behalf of the company.')
                        : undefined
                  }
                  submit={(signature) => act('signed', signature)}
                />
              ) : (
                <button
                  className="v9-button v9-button-primary"
                  disabled={busy||!formReady||kind==='Form'&&editing}
                  onClick={() => act(pending?.kind === 'approve' ? 'approved' : 'reviewed')}
                >
                  {pending?.kind === 'approve'
                    ? copy(editing && dirty ? 'Approve letter and save wording' : 'Approve letter')
                    : copy(editing && dirty ? 'Complete review and save wording' : 'Complete review')}
                </button>
              )}
              {pending && (
                <button
                  className="v9-button"
                  disabled={busy || !comment.trim() || (editing && dirty)}
                  onClick={() => act('returned')}
                >
                  {copy('Send back to owner')}
                </button>
              )}
            </ContractPanel>
          )}
          {letter.state === 'released' && (
            <p className="v9-notice">
              {copy('Released ')}
              {contractDate(letter.releasedAt)}
              {copy('. This letter is retained with its signature and action history.')}
            </p>
          )}
          {letter.state === 'withdrawn' && (
            <p className="v9-notice">{copy('This letter was withdrawn. Its retained history remains available.')}</p>
          )}
          {capabilities.canBindEmployee && (
            <ContractPanel title={copy(capabilities.canSelfBind?'Confirm your account to continue':'Employee account needs attention')}>
              <p>
                {copy(
                  capabilities.canSelfBind?'This confirms your own verified AIHR account for the pending employee step. Nobody else can be selected to sign for you.':'The employee must have exactly one active, verified AIHR account linked to their Personnel record. No substitute signer can be selected.',
                )}
              </p>
              <button
                className="v9-button"
                disabled={busy}
                onClick={() =>
                  execute(() => bindSharedEmployee(letter.id), 'The verified employee account was checked and linked.')
                }
              >
                {copy(capabilities.canSelfBind?'Confirm your account to continue':'Check employee account again')}
              </button>
            </ContractPanel>
          )}
        </div>
        <aside className="v9-stack">
          <ContractPanel title={copy('Letter routing')}>
            <ol className="contract-rail">
              {letter.layers.map((layer) => (
                <li key={layer.id}>
                  {layer.fulfilled ? (
                    <CheckCircle2 aria-hidden />
                  ) : layer.unavailable ? (
                    <AlertCircle aria-hidden />
                  ) : (
                    <Circle aria-hidden />
                  )}
                  <div>
                    <strong>
                      {layer.label}
                      {layer.owner ? copy(' · Owner') : ''}
                    </strong>
                    <p>{layer.assigneeName || 'Waiting for linked account'}</p>
                    <small>
                      {layer.fulfilled
                        ? copy('Completed')
                        : pending?.stepId === layer.id
                          ? copy('Your current step')
                          : layer.unavailable
                            ? copy('Needs attention')
                            : `Order ${layer.stage}`}
                    </small>
                  </div>
                </li>
              ))}
            </ol>
          </ContractPanel>
          <ContractPanel title={copy('Action history')}>
            {!letter.history.length ? (
              <p className="v9-muted">{copy('No actions recorded yet.')}</p>
            ) : (
              <ol className="contract-rail">
                {letter.history.map((item) => (
                  <li key={item.id}>
                    <CheckCircle2 aria-hidden />
                    <div>
                      <strong>{item.actorName}</strong>
                      <p>
                        {copy(
                          (
                            {
                              signed: 'Signed',
                              reviewed: 'Reviewed',
                              approved: 'Approved',
                              returned: 'Sent back',
                              resent: 'Resent',
                              declined: 'Declined',
                            } as Record<string, string>
                          )[item.action] ?? item.action,
                        )}{' '}
                        · {contractTimestamp(item.at)}
                      </p>
                      {item.comment && <p className="v9-prewrap">{item.comment}</p>}
                      <small>
                        {copy('Content revision ')}
                        {item.revision} · {copy('Content fingerprint')} {item.hash.slice(0, 12)}…
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </ContractPanel>
        </aside>
      </div>
    </div>
  );
}

function documentVisibility(){return globalThis.document.visibilityState==='visible';}
