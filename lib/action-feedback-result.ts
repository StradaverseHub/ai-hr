/** Next server actions throw a redirect digest instead of returning a result. */
export function isActionRedirect(error: unknown): error is { digest: string; handled?: unknown } {
  if (typeof error !== 'object' || error === null || !('digest' in error) || typeof error.digest !== 'string') return false;
  return /^NEXT_REDIRECT;(?:push|replace);[\s\S]*;(?:303|307|308);$/.test(error.digest);
}

/** Only a redirect already accepted by Next is navigation, rather than an unknown write result. */
export function isHandledActionRedirect(error:unknown):boolean {
 return isActionRedirect(error)&&error.handled===true;
}
