export const NAVIGATION_START = 'aihr:navigation-start';

export function navigationKind(current: URL, destination: URL) {
  if (current.origin !== destination.origin) return null;
  if (current.pathname !== destination.pathname) return 'navigate';
  const filters = (url: URL) => {
    const params = new URLSearchParams(url.search);
    for (const key of ['toast', 'error', 'approvalSeal']) params.delete(key);
    return params.toString();
  };
  return filters(current) !== filters(destination) ? 'filter' : null;
}
