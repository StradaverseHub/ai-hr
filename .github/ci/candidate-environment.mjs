/** Candidate subprocesses never inherit CI/platform/provider credentials.
 * Declared disposable database URLs are a separate purpose capability and remain
 * available to their migration/test owner; canonical-preparation closes them. */
const credential=/(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY|API_KEY|ACCESS_KEY)(?:_|$)/i;
const ownedDatabaseNames=new Set(['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']);
const databaseCapability=/(?:^|_)(?:DATABASE|DB|POSTGRES|MYSQL|MONGO|REDIS)(?:_[A-Z0-9]+)*_(?:URL|URI|DSN|CONNECTION_STRING)(?:_|$)/i;
export function candidateEnvironment(environment){
 return Object.fromEntries(Object.entries(environment).filter(([name,value])=>value!==undefined&&!credential.test(name)&&name!=='SSH_AUTH_SOCK'
  &&(ownedDatabaseNames.has(name)||!databaseCapability.test(name)&&!/^PG[A-Z0-9_]*$/.test(name))));
}
export function nativePreparationEnvironment(environment){
 const safe=candidateEnvironment(environment),closed='postgres://nobody:nothing@127.0.0.1:1/no_database';
 for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])safe[key]=closed;
 return safe;
}
