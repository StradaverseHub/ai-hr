/** Stop only the internal report installation's owned unit names. */
export function stopInternalReportWorkers(systemctl:(...args:string[])=>string){
 const owned=systemctl('list-units','--all','--plain','--no-legend').split('\n').map(line=>line.trim().split(/\s+/)[0]).filter(unit=>['aihr-smtp-token.socket','aihr-internal-report.socket','aihr-internal-report.service','aihr-report-auth.socket','aihr-report-renderer.socket'].includes(unit)||((unit.startsWith('aihr-smtp-token@')||unit.startsWith('aihr-report-auth@')||unit.startsWith('aihr-report-renderer@'))&&unit.endsWith('.service')));
 const existing=owned.filter(unit=>{
  const state:Record<string,string>={};
  for(const row of systemctl('show',unit,'--property=LoadState','--property=ActiveState','--property=MainPID').trim().split('\n')){
   const match=row.match(/^(LoadState|ActiveState|MainPID)=(.*)$/);
   if(!match||Object.hasOwn(state,match[1]))throw new Error('Ambiguous report worker state.');
   state[match[1]]=match[2];
  }
  // systemd may retain an absent rollback socket in list-units, omitting MainPID entirely.
  // Only proved inactive absence is safe to skip; stop must still fail for real loaded units.
  if(state.LoadState==='not-found'){
   if(state.ActiveState!=='inactive'||(state.MainPID!==undefined&&state.MainPID!=='0'))throw new Error('Absent report worker is not inactive.');
   return false;
  }
  if(state.LoadState!=='loaded'||!['active','activating','deactivating','inactive','failed','reloading','maintenance','refreshing'].includes(state.ActiveState)||state.MainPID!==undefined&&!/^\d+$/.test(state.MainPID))throw new Error('Unknown report worker state.');
  return true;
 });
 if(existing.length)systemctl('stop',...existing);
}
