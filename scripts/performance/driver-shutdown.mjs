/** Close only the isolated child's real native and observer pools, retaining actual completion. */
/** @param {import('postgres').Sql|undefined} nativeAuditClient @param {import('postgres').Sql} driver @param {(key:'nativeAuditPoolClosed'|'driverPoolClosed')=>void} record */
export async function closePerformanceDbPools(nativeAuditClient,driver,record){
 if(nativeAuditClient)await nativeAuditClient.end({timeout:5});record('nativeAuditPoolClosed');
 await driver.end({timeout:5});record('driverPoolClosed');
}

/** tsx can expose destructured TS exports through CommonJS default on the hosted Node runtime.
 * @param {{client?:import('postgres').Sql,default?:{client?:import('postgres').Sql}} module */
export function performanceNativeDbClient(module){
 const client=module.client??module.default?.client;
 if(!client||typeof client.end!=='function')throw Error('Canonical native database client export unavailable');
 return client;
}
