/** Login namespace syntax shared by intake and the owner-role provisioner. */
export function organizationCode(value: string): string {
  const code = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(code)) {
    throw new Error('Use 2–64 lowercase letters, numbers or hyphens for the organization code.');
  }
  if (['operator', 'system', 'admin', 'root'].includes(code)) {
    throw new Error('This organization code is reserved for installation administration.');
  }
  return code;
}
