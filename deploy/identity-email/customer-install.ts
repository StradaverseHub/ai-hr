/** Operator-only remote HR database configuration. Never accept this from an HTTP request. */
export function customerEmailDatabase(migration: string, service: string) {
  let owner: URL, worker: URL;
  try { owner = new URL(migration); worker = new URL(service); }
  catch { throw new Error('Invalid private identity database configuration'); }
  for (const url of [owner, worker]) {
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.pathname.length < 2 || url.hash) throw new Error('Invalid private identity database configuration');
    if ([...url.searchParams.keys()].some(key => ['user','username','password','pass','host','hostname','port','database','dbname','role','options','ssl'].includes(key.toLowerCase()))) throw new Error('Identity database connection overrides refused');
    if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) && (url.searchParams.getAll('sslmode').length !== 1 || url.searchParams.get('sslmode') !== 'verify-full')) throw new Error('Remote identity database requires verified TLS');
  }
  if (owner.hostname !== worker.hostname || (owner.port || '5432') !== (worker.port || '5432') || owner.pathname !== worker.pathname || decodeURIComponent(worker.username) !== 'aihr_identity_email' || worker.username === owner.username) throw new Error('Use the separate aihr_identity_email role on the same HR database');
  return worker;
}
export function customerSocketGroup(value: string) {
  if (!/^[a-z_][a-z0-9_-]*[$]?$/.test(value)) throw new Error('Invalid application socket group');
  return value;
}
