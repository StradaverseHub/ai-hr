'use client';
import { useState } from 'react';

export function ConfigurationSaveError({ error, retry, reload, copy }: { error: string; retry: () => void; reload: () => void;copy?:(key:string)=>string }) {
  const t=(key:string,fallback:string)=>copy?.(key)??fallback;
  const [confirming, setConfirming] = useState(false);
  return <section className="v9-notice v9-error" role="alert">
    <p>{error}</p>
    {confirming ? <div role="alertdialog" aria-label={t('reloadTitle','Reload saved settings?')} className="v9-stack">
      <p>{t('reloadHelp','Reloading will discard your unsaved changes and restore the last saved settings.')}</p>
      <div className="v9-actions">
        <button type="button" className="v9-button v9-button-danger" onClick={reload}>{t('discardReload','Discard changes and reload')}</button>
        <button type="button" className="v9-button" autoFocus onClick={() => setConfirming(false)}>{t('keepEditing','Keep editing')}</button>
      </div>
    </div> : <div className="v9-actions">
      <button type="button" className="v9-button" onClick={retry}>{t('retrySave','Try saving again')}</button>
      <button type="button" className="v9-button" onClick={() => setConfirming(true)}>{t('reloadSaved','Reload saved settings')}</button>
    </div>}
  </section>;
}
