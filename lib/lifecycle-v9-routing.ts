/** Server layout and client navigation must agree on the complete V9 shell boundary. */
export function isLifecycleV9Path(pathname: string | null | undefined): boolean {
  return pathname === '/lifecycle/v9' || pathname?.startsWith('/lifecycle/v9/') === true;
}
