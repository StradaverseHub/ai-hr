import {Preparation} from '../preparation';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){return <Preparation kind="route" query={await searchParams}/>;}
