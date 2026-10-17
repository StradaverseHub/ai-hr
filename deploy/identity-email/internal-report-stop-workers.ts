/** Stop only the internal report installation's owned unit names. */
export function stopInternalReportWorkers(systemctl:(...args:string[])=>string){
 const owned=systemctl('list-units','--all','--plain','--no-legend').split('\n').map(line=>line.trim().split(/\s+/)[0]).filter(unit=>['aihr-internal-report.socket','aihr-internal-report.service','aihr-report-auth.socket','aihr-report-renderer.socket'].includes(unit)||((unit.startsWith('aihr-report-auth@')||unit.startsWith('aihr-report-renderer@'))&&unit.endsWith('.service')));
 if(owned.length)systemctl('stop',...owned);
}
