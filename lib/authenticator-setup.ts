/** The QR and explicit app handoff must enroll the same TOTP account. No app is selected here. */
export function authenticatorSetupUri(secret: string, account = ''): string {
  return `otpauth://totp/${encodeURIComponent(`AI HR:${account}`)}?${new URLSearchParams({
    secret, issuer: 'AI HR', algorithm: 'SHA1', digits: '6', period: '30',
  })}`;
}
