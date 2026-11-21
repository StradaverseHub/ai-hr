'use client';
import { ConfigurationSaveError } from './configuration-save-error';
import type { V9ConfigurationState } from './use-v9-configuration';
export type SaveCopy = (key: string, values?: Record<string, string | number>) => string;
/** Visible within the modal: an upload receipt alone never means the definition was saved. */
export function ConfigurationSaveStatus({ state, error, retry, reload, names = [], uploading = false, copy }: { state: V9ConfigurationState; error: string; retry: () => void; reload: () => void; names?: string[]; uploading?: boolean; copy?: SaveCopy }) {
  const l = (key: string, fallback: string, values?: Record<string,string|number>) => copy?.(key, values) ?? fallback;
  const label = uploading ? l('ackUploading','Uploading… Changes not saved') : state === 'saved' ? l('ackSaved','Saved') : state === 'error' ? l('ackNotSaved','Changes not saved') : l('ackSaving','Saving…');
  return <section className="v9-stack" aria-label={l('ackStatus','Template save status')}>
    <p role="status" className={state === 'saved' && !uploading ? 'v9-muted' : 'v9-notice v9-warning'}>{label}</p>
    {state === 'error' && <>
      <p className="v9-error">{names.length ? l('ackImageFailed',`Could not save changes to ${names.join(', ')}.`,{names:names.join(', ')}) : l('ackFailed','Could not save this template.')}{' '}{l('ackRetained','Your image, description and current edits are still here.')}</p>
      <ConfigurationSaveError error={error} retry={retry} reload={reload} copy={copy}/>
    </>}
  </section>;
}
