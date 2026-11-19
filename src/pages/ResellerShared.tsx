import {api,ApiError} from '@/lib/api'
import type {ReactNode} from 'react'
import {Button} from '@/components/ui/button'
export type ResellerSession={account:{id:string;email:string;name:string;version:number;mfa_enabled:boolean};organization:{id:string;name:string;key:string;status:string;role:string;available:boolean}|null;expires_at:string;idle_timeout_seconds:number}
export function ResellerTable({label,children}:{label:string;children:ReactNode}){return <div className="sa-table-scroll" role="region" aria-label={label} tabIndex={0}><table className="sa-table">{children}</table></div>}
export function ResellerPager({next,cursor,history,setCursor,setHistory}:{next:string|null;cursor:string;history:string[];setCursor:(v:string)=>void;setHistory:(v:string[])=>void}){return <div className="sa-pagination"><Button type="button" variant="outline" disabled={!history.length} onClick={()=>{setCursor(history.at(-1)||'');setHistory(history.slice(0,-1))}}>Previous page</Button><span>Up to 25 per page</span><Button type="button" variant="outline" disabled={!next} onClick={()=>{setHistory([...history,cursor]);setCursor(next||'')}}>Next page</Button></div>}
export async function resellerRequest<T=any>(path:string,body?:unknown,method=body===undefined?'GET':'POST'):Promise<T>{
 try{
  const value=await api<T>('/reseller'+path,{method,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)})
  window.dispatchEvent(new Event('drykraft-rs-activity'));return value
 }catch(error){
  if(error instanceof ApiError&&error.status===401&&!['/login','/mfa','/mfa/setup','/session'].includes(path))window.dispatchEvent(new Event('drykraft-rs-expired'))
  if(['TimeoutError','AbortError'].includes((error as Error).name))throw new Error(body===undefined?'Loading timed out. Try this page again.':'Confirmation timed out. Check the saved result before repeating this action.')
  throw error
 }
}
