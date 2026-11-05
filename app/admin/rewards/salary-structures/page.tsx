import {RewardLibraryPage} from '../libraries/page-content';
export default async function Page({searchParams}:{searchParams:Promise<{year?:string;version?:string;copy?:string;compare?:string;error?:string;next?:string}>}){return <RewardLibraryPage kind="salary" params={await searchParams}/>;}
