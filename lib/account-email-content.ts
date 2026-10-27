/** One rendering owner for account emails and previews. Preview links are deliberately nonfunctional. */
export function invitationEmailContent(organization:string,activationUrl:string){
 return {subject:'Your AI HR invitation',text:`You have been invited to AI HR. Organization code: ${organization}. Open the link to choose your username and password and enroll your authenticator.\n\n${activationUrl}\n\nThis invitation expires after seven days.`};
}
export function recoveryEmailContent(resetUrl:string){
 return {subject:'Reset your AI HR password',text:`A password reset was requested for your AI HR login.\n\nOpen this link within 30 minutes:\n${resetUrl}\n\nYour authenticator or a recovery code is still required if MFA is enrolled. If you did not request this, you can ignore this email.`};
}
export function accountEmailPreview(kind:'invitation'|'recovery'){
 return kind==='invitation'?invitationEmailContent('[organization code]','[Activation link hidden]'):recoveryEmailContent('[Password reset link hidden]');
}
