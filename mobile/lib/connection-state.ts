import type { VerifiedCompanyProfile } from './company-profile';
type Selection = { raw: string; profile: VerifiedCompanyProfile };
type Ports = { read(): Promise<string | null>; write(raw: string): Promise<void>; verify(raw: string): VerifiedCompanyProfile; clearSession(): Promise<void>; clearFiles(): Promise<void>; apply(profile: VerifiedCompanyProfile | null): void };
/** A switch closes private views before any await; cleanup failure never installs new endpoints. */
export function createConnectionState(p: Ports) {
  let snapshot: { status: 'loading' | 'ready' | 'switching' | 'error'; selection: Selection | null; generation: number } = { status: 'loading', selection: null, generation: 0 };
  const listeners = new Set<() => void>();
  let flight: Promise<void> | null = null;
  let initialization: Promise<void> | null = null;
  function update(value: typeof snapshot) { snapshot = value; listeners.forEach(l => l()); }
  function initialize() {
    if(!initialization)initialization=(async()=>{
      try { const raw = await p.read(); const selection = raw ? {raw, profile: p.verify(raw)} : null; p.apply(selection?.profile ?? null); update({...snapshot, status:'ready',selection}); }
      catch { p.apply(null); update({...snapshot, status:'error'}); }
    })();
    return initialization;
  }
  function select(raw: string) {
    if (flight) return flight;
    if(snapshot.status==='loading')throw new Error('Company setup is still loading.');
    const profile = p.verify(raw); // Untrusted input cannot disturb an existing session.
    update({...snapshot, status:'switching'});
    flight = (async () => {
      try {
        await p.clearSession(); await p.clearFiles();
        // Recheck expiration after potentially delayed OS cleanup.
        p.verify(raw); await p.write(raw); p.apply(profile);
        update({status:'ready', selection:{raw,profile}, generation:snapshot.generation+1});
      } catch { update({...snapshot, status:'error'}); throw new Error('Company change could not finish. Retry to clear the old session.'); }
      finally { flight = null; }
    })();
    return flight;
  }
  return { initialize, select, getSnapshot: () => snapshot, subscribe(l:()=>void) { listeners.add(l); return ()=>{listeners.delete(l);}; } };
}
