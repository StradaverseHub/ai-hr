/** Candidate subprocesses never inherit CI/platform/provider credentials.
 * Declared disposable database URLs are a separate purpose capability and remain
 * available to their migration/test owner; canonical-preparation closes them. */
const credential=/(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY|API_KEY|ACCESS_KEY)(?:_|$)/i;
export function candidateEnvironment(environment){
 return Object.fromEntries(Object.entries(environment).filter(([name,value])=>value!==undefined&&!credential.test(name)&&name!=='SSH_AUTH_SOCK'));
}
export function nativePreparationEnvironment(environment){
 const safe=candidateEnvironment(environment),closed='postgres://nobody:nothing@127.0.0.1:1/no_database';
 for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])safe[key]=closed;
 return safe;
}
