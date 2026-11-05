import {RewardLibraryPage} from '../libraries/page-content';
export default async function Page({searchParams}:{searchParams:Promise<{year?:string;version?:string;copy?:string;compare?:string;error?:string;next?:string;legacy?:string}>}){return <RewardLibraryPage kind="bonus" params={await searchParams}/>;}
