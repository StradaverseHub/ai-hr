/** Return navigation is an allowlisted UI context, never an arbitrary client URL. */
export function leaveSelfReturnUrl(formData: FormData, key: 'error' | 'toast', value: string): string {
  const history = formData.get('leaveOrigin') === 'history';
  const query = new URLSearchParams();
  if (history) {
    const incoming = new URLSearchParams(String(formData.get('leaveContext') ?? ''));
    for (const name of ['hTab','hType','hFrom','hTo','leaveYear','year','state','loaded', 'warnHoliday']) {
      for (const item of incoming.getAll(name)) if (item.length <= 200) query.append(name,item);
    }
  }
  query.set(key,value);
  return `${history ? '/leave/history' : '/leave'}?${query}`;
}
