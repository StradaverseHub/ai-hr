'use client';
import { useState } from 'react';

export function ConfigurationSaveError({ error, retry, reload }: { error: string; retry: () => void; reload: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return <section className="v9-notice v9-error" role="alert">
    <p>{error}</p>
    {confirming ? <div role="alertdialog" aria-label="Reload saved settings?" className="v9-stack">
      <p>Reloading will discard your unsaved changes and restore the last saved settings.</p>
      <div className="v9-actions">
        <button type="button" className="v9-button v9-button-danger" onClick={reload}>Discard changes and reload</button>
        <button type="button" className="v9-button" autoFocus onClick={() => setConfirming(false)}>Keep editing</button>
      </div>
    </div> : <div className="v9-actions">
      <button type="button" className="v9-button" onClick={retry}>Try saving again</button>
      <button type="button" className="v9-button" onClick={() => setConfirming(true)}>Reload saved settings</button>
    </div>}
  </section>;
}
