import {Preparation} from '../preparation';
import {SettingsScope} from '../settings-scope';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){const query=await searchParams;return <main><SettingsScope query={query}/><Preparation kind="settings" query={query} embedded/></main>;}
