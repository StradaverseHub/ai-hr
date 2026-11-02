/** Ephemeral confirmation UI only. The server still decides permissions and business outcomes. */
export type InAppAlertButton = { text?: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => void };
export type AlertScope = { generation: number; route: string; employmentId: string | null; active: boolean };
export type InAppAlertState = { id: number; title: string; message: string; buttons: readonly InAppAlertButton[] };

export function createInAppAlertState() {
  let readScope: (() => AlertScope) | null = null;
  let host: object | null = null;
  let current: (InAppAlertState & { scope: AlertScope; host: object }) | null = null;
  let sequence = 0;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const clear = () => { if (current) { current = null; emit(); } };
  function valid(dialog: NonNullable<typeof current>) {
    const scope = readScope?.();
    return host === dialog.host && !!scope?.active && scope.generation === dialog.scope.generation
      && scope.route === dialog.scope.route && scope.employmentId === dialog.scope.employmentId;
  }
  function press(id: number, index: number) {
    const dialog = current;
    if (!dialog || dialog.id !== id || !Number.isInteger(index) || index < 0 || index >= dialog.buttons.length) return;
    const permitted = valid(dialog);
    const callback = dialog.buttons[index].onPress;
    // Consume first: rapid taps, retained callbacks and re-entrant renders cannot invoke this action twice.
    clear();
    if (permitted && valid(dialog)) callback?.();
  }
  return {
    getSnapshot: (): InAppAlertState | null => current,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    attach(reader: () => AlertScope) {
      clear();
      const owner = {};
      host = owner; readScope = reader;
      return () => { if (host === owner) { host = null; readScope = null; clear(); } };
    },
    show(title: string, message = '', buttons: readonly InAppAlertButton[] = [{}]) {
      const scope = readScope?.();
      if (!host || !scope?.active || current) return;
      current = { id: ++sequence, title, message, buttons: buttons.length ? buttons.map(button => ({ ...button })) : [{}], scope: { ...scope }, host };
      emit();
    },
    press,
    dismiss() {
      if (!current) return;
      const index = current.buttons.findIndex(button => button.style === 'cancel');
      if (index < 0) clear(); else press(current.id, index);
    },
    clear,
    reconcile() { if (current && !valid(current)) clear(); },
  };
}
