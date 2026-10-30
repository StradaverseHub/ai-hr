import type { Config } from './lifecycle-v9-model';
export function v9CompanySigners(config:Config,companyId:string):string[]{
  const company=config.companies?.find(company=>company.companyId===companyId);
  return [...new Set(company?.allowedSignatoryUserIds??(company?.signatoryUserId?[company.signatoryUserId]:[]))];
}
export function v9SignatoryTitle(config:Config,userId:string|null|undefined,companyId:string):string{
  const company=config.companies?.find(company=>company.companyId===companyId);
  return userId?config.signatoryTitles?.[userId]??(company?.signatoryUserId===userId?company.signatoryTitle:''):'';
}
