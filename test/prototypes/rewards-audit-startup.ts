/** Test-only closed decoder. Omitted preserves the original prototype behavior. */
export function rewardsAuditPrototypeStartup(input:unknown):Readonly<{connect_timeout?:2}>{
 if(input!==undefined&&input!==2)throw Error('Only the explicit owned two-second startup is supported');
 return Object.freeze(input===undefined?{}:{connect_timeout:2});
}
