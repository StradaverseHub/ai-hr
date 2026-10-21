export type AccessEditorFailure='invalid'|'changed'|'unsupported'|'ceiling'|'lastAdministrator'|'system';
export type AccessEditorResult<T>={ok:true;value:T}|{ok:false;code:AccessEditorFailure};
