'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { observePageStyles, type PageStyleRecoveryState } from '@/lib/page-style-recovery';

export function PageStyleRecovery() {
  const t = useTranslations('pageStyleRecovery');
  const [state, setState] = useState<PageStyleRecoveryState>(null);
  const panel = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const active = state !== null;
  useEffect(() => observePageStyles(document, setState), []);
  useEffect(() => {
    if (!active || !dialog.current) return;
    const surface = dialog.current;
    surface.showModal();
    return () => { if (surface.open) surface.close(); };
  }, [active]);
  useEffect(() => { if (state === 'failed') panel.current?.focus(); }, [state]);
  if (!state) return null;
  // Inline styles deliberately keep this recovery surface usable when the stylesheet failed.
  return createPortal(<dialog ref={dialog} aria-label={t(state === 'failed' ? 'failed' : 'restoring')} onCancel={event => event.preventDefault()}
    style={{ position: 'fixed', inset: 0, width: '100vw', height: '100dvh', maxWidth: 'none', maxHeight: 'none', boxSizing: 'border-box', margin: 0, border: 0,
      display: 'grid', placeContent: 'center', padding: 24, background: '#fafafa', color: '#171717', fontFamily: 'system-ui, sans-serif', textAlign: 'center' }}>
    <div ref={panel} tabIndex={-1} role={state === 'failed' ? 'alert' : 'status'} aria-busy={state === 'retrying'} style={{ display: 'grid', gap: 16 }}>
    <p style={{ margin: 0, maxWidth: 440, lineHeight: 1.6 }}>{t(state === 'failed' ? 'failed' : 'restoring')}</p>
    {state === 'failed' ? <button type="button" onClick={() => window.location.reload()}
      style={{ minHeight: 44, padding: '10px 20px', borderRadius: 8, border: '1px solid #171717', background: '#171717', color: '#fff', font: 'inherit', cursor: 'pointer' }}>{t('reload')}</button> : null}
    </div>
  </dialog>, document.body);
}
