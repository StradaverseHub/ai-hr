/** Return navigation is an allowlisted UI context, never an arbitrary client URL. */
export function withLeaveEmploymentContext(href:string,employmentId:string|undefined):string{
  if(!employmentId)return href;
  if(!/^\/leave(?:\/history)?\?/.test(href)||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(employmentId))throw Error('Invalid own leave return context.');
  return href+'&employmentId='+encodeURIComponent(employmentId);
}
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
