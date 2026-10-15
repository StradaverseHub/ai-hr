export type PageStyleRecoveryState = 'retrying' | 'failed' | null;

/** Recover a failed Next stylesheet, without reloading a page containing credentials or edits. */
export function observePageStyles(doc: Document, changed: (state: PageStyleRecoveryState) => void) {
  const view = doc.defaultView;
  if (!view) return () => {};
  type Attempt = { original: HTMLLinkElement; url: URL; tries: number; state: 'retrying' | 'failed' | 'ready'; cancel?: () => void };
  const attempts = new Map<string, Attempt>();
  const replacements = new WeakSet<HTMLLinkElement>();
  // This is a public cache key, not an authentication token.
  const cacheKey = Math.random().toString(36).slice(2);
  let stopped = false;
  function publish() {
    if (stopped) return;
    const values = [...attempts.values()];
    changed(values.some(value => value.state === 'failed') ? 'failed' : values.some(value => value.state === 'retrying') ? 'retrying' : null);
  }
  function ownStylesheet(target: EventTarget | null) {
    if (!(target instanceof view!.HTMLLinkElement) || target.rel !== 'stylesheet' || target.disabled || replacements.has(target) || target.dataset.aihrStyleOriginal) return null;
    try {
      const url = new URL(target.href, doc.baseURI);
      return url.origin === view!.location.origin && url.pathname.startsWith('/_next/static/') && url.pathname.endsWith('.css') ? { link: target, url } : null;
    } catch { return null; }
  }
  function retry(attempt: Attempt) {
    if (stopped) return;
    if (!attempt.original.isConnected) { attempt.state = 'ready'; publish(); return; }
    attempt.tries += 1;
    attempt.state = 'retrying';
    const link = attempt.original.cloneNode(true) as HTMLLinkElement;
    const url = new URL(attempt.url);
    url.searchParams.set('_aihr_style_retry', `${cacheKey}-${attempt.tries}`);
    link.href = url.href;
    link.dataset.aihrStyleOriginal = attempt.url.href;
    replacements.add(link);
    let settled = false;
    const removeListeners = () => { link.removeEventListener('load', loaded); link.removeEventListener('error', failed); view!.clearTimeout(timer); };
    const loaded = () => {
      if (settled || stopped) return;
      settled = true; removeListeners(); attempt.cancel = undefined; attempt.state = 'ready';
      if (!attempt.original.isConnected) link.remove();
      publish();
      // Retain the loaded replacement across provider cleanup/navigation. Removing it would
      // recreate the missing-style defect. The React-owned original is never changed or removed.
    };
    const failed = () => {
      if (settled || stopped) return;
      settled = true; removeListeners(); link.remove(); attempt.cancel = undefined;
      if (attempt.tries < 2) retry(attempt);
      else { attempt.state = 'failed'; publish(); }
    };
    const timer = view!.setTimeout(failed, 6000);
    attempt.cancel = () => { settled = true; removeListeners(); link.remove(); };
    link.addEventListener('load', loaded);
    link.addEventListener('error', failed);
    // Preserve stylesheet order, integrity, nonce and relative font/image URL resolution.
    attempt.original.after(link);
    publish();
  }
  function recover(target: EventTarget | null) {
    const owned = ownStylesheet(target);
    if (!owned || attempts.has(owned.url.href)) return;
    if ([...doc.querySelectorAll<HTMLLinkElement>('link[data-aihr-style-original]')].some(link =>
      link.dataset.aihrStyleOriginal === owned.url.href && !link.disabled && link.sheet)) return;
    const attempt: Attempt = { original: owned.link, url: owned.url, tries: 0, state: 'retrying' };
    attempts.set(owned.url.href, attempt); retry(attempt);
  }
  const errored = (event: Event) => recover(event.target);
  // CSS may already have failed before React hydrated. A completed document distinguishes
  // that case from a healthy stylesheet which is still downloading.
  const inspectCompleted = () => doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach(link => { if (!link.sheet) recover(link); });
  doc.addEventListener('error', errored, true);
  if (doc.readyState === 'complete') inspectCompleted();
  else view.addEventListener('load', inspectCompleted, { once: true });
  return () => {
    stopped = true;
    doc.removeEventListener('error', errored, true);
    view.removeEventListener('load', inspectCompleted);
    for (const attempt of attempts.values()) attempt.cancel?.();
  };
}
