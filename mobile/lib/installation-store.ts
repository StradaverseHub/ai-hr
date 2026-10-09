type Ports = {
  markerExists: () => boolean;
  createMarker: () => void;
  logoutPending?: () => boolean;
  markLogoutPending?: () => void;
  read: () => Promise<string | null>;
  write: (value: string) => Promise<void>;
  remove: () => Promise<void>;
};

/** Clear surviving Keychain entries BEFORE creating the first-install marker. Failures retry. */
export function createInstallationStore(ports: Ports) {
  let initialization: Promise<void> | null = null;
  function initialize() {
    if (!initialization) {
      initialization = (async () => {
        if (ports.markerExists() && !ports.logoutPending?.()) return;
        await ports.remove();
        ports.createMarker();
      })().catch((error: unknown) => { initialization = null; throw error; });
    }
    return initialization;
  }
  return {
    async read() { await initialize(); return ports.logoutPending?.() ? null : ports.read(); },
    async write(value: string) { await initialize(); await ports.write(value); },
    async remove() { await initialize(); await ports.remove(); },
    markLoggedOut() { ports.markLogoutPending?.(); },
    markSignedIn() { ports.createMarker(); },
  };
}
