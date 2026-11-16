import {Preparation} from '../preparation';
import '../../../automation/pcg.css';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){return <Preparation kind="form" query={await searchParams}/>;}
