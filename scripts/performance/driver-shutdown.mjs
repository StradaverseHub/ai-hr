/** Close only the isolated child's real native and observer pools, retaining actual completion. */
/** @param {import('postgres').Sql|undefined} nativeAuditClient @param {import('postgres').Sql} driver @param {(key:'nativeAuditPoolClosed'|'driverPoolClosed')=>void} record */
export async function closePerformanceDbPools(nativeAuditClient,driver,record){
 if(nativeAuditClient)await nativeAuditClient.end({timeout:5});record('nativeAuditPoolClosed');
 await driver.end({timeout:5});record('driverPoolClosed');
}
