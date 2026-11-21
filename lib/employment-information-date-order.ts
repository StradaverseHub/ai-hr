/** Shared employment owner ordering for current writes and original-hire assertions. */
export function assertEmploymentInformationDateOrder(p:{hire:string|null;join:string|null;confirmation:string|null;extendedConfirmation:string|null;tender:string|null;resignation:string|null;lastWorking:string|null}){
 const {hire,join,confirmation,extendedConfirmation,tender,resignation,lastWorking}=p;
 if(join&&hire&&join<hire)throw new Error('Join date cannot be earlier than the group join date.');
 if(confirmation&&hire&&confirmation<hire)throw new Error('Confirmation date cannot be earlier than the hire date.');
 if(resignation&&hire&&resignation<hire)throw new Error('Resignation date cannot be earlier than the hire date.');
 if(extendedConfirmation&&confirmation&&extendedConfirmation<confirmation)throw new Error('Extended confirmation date cannot be earlier than the confirmation date.');
 if(tender&&resignation&&tender>resignation)throw new Error('Tender resignation date cannot be later than the resignation date.');
 if(resignation&&lastWorking&&resignation>lastWorking)throw new Error('Resignation date cannot be later than the last working date.');
 if(tender&&lastWorking&&tender>lastWorking)throw new Error('Tender resignation date cannot be later than the last working date.');
 if(tender&&hire&&tender<hire)throw new Error('Tender resignation date cannot be earlier than the hire date.');
 if(lastWorking&&hire&&lastWorking<hire)throw new Error('Last working date cannot be earlier than the hire date.');
}
