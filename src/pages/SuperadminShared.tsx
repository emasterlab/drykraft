import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react'
import {Skeleton} from '@/components/ui/skeleton'
import {api,ApiError} from '@/lib/api'
import {useBlocker} from 'react-router-dom'
import {Button} from '@/components/ui/button'
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog'
export type Account={id:string;email:string;name:string;role:string;disabled:boolean;version:number;mfa_enabled:boolean}
export const roleLabel=(role:string)=>({owner:'Owner',admin:'Administrator',support:'Support',billing:'Billing',viewer:'Read only'}[role]||role)
export const date=(value:unknown)=>typeof value==='string'?new Intl.DateTimeFormat('en',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'Not set'
export async function request<T=any>(path:string,body?:unknown,method=body===undefined?'GET':'POST'):Promise<T>{
 try{const result=await api<T>('/sa'+path,{method,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});window.dispatchEvent(new Event('drykraft-sa-activity'));return result}
 catch(e){if(e instanceof ApiError&&e.status===401&&!['/login','/mfa','/mfa/setup','/session'].includes(path))window.dispatchEvent(new Event('drykraft-sa-expired'));if((e as Error).name==='TimeoutError'||(e as Error).name==='AbortError')throw new Error(body===undefined?'The request timed out. Try loading this page again.':'Confirmation timed out. Reload the saved state before repeating this action.');throw e}
}
export function useData<T>(path:string|null,requester:typeof request=request){
 const [saved,setSaved]=useState<{path:string|null;data:T|null}>({path:null,data:null}),[error,setError]=useState(''),[pending,setPending]=useState(true),[sequence,setSequence]=useState(0),[loadedPath,setLoadedPath]=useState<string|null>(null)
 const reload=useCallback(()=>setSequence(n=>n+1),[])
 const setData=useCallback((data:T|null)=>setSaved({path,data}),[path])
 useEffect(()=>{let mounted=true;setPending(true);setError('');if(!path){setPending(false);return}requester<T>(path).then(d=>{if(mounted)setSaved({path,data:d})}).catch(e=>{if(mounted)setError(e.message)}).finally(()=>{if(mounted){setLoadedPath(path);setPending(false)}});return()=>{mounted=false}},[path,sequence,requester])
 return {data:saved.path===path?saved.data:null,error:loadedPath===path?error:'',loading:!!path&&(pending||loadedPath!==path),reload,setData}
}
export function Loading(){return <div className="sa-loading" role="status"><span className="sr-only">Loading administration data...</span><Skeleton className="h-8 w-56"/><Skeleton className="h-12 w-full"/><Skeleton className="h-64 w-full"/></div>}
export function Field({label,children}: {label:string;children:ReactNode}){return <label className="sa-field">{label}{children}</label>}
export function Notice({children}:{children:ReactNode}){return <p className="sa-notice">{children}</p>}

export function confirmDiscard(message:string,action:()=>void,cancel?:()=>void,title?:string){window.dispatchEvent(new CustomEvent('drykraft-sa-discard',{detail:{message,action,cancel,title}}))}
export function DiscardConfirmation(){
 const [pending,setPending]=useState<{message:string;action:()=>void;cancel?:()=>void;title?:string}|null>(null)
 useEffect(()=>{const receive=(e:Event)=>setPending((e as CustomEvent).detail);window.addEventListener('drykraft-sa-discard',receive);return()=>window.removeEventListener('drykraft-sa-discard',receive)},[])
 function keep(){pending?.cancel?.();setPending(null)}
 return <Dialog open={!!pending} onOpenChange={open=>{if(!open)keep()}}><DialogContent><DialogTitle>{pending?.title||'Discard unsaved changes?'}</DialogTitle><DialogDescription>{pending?.message}</DialogDescription><div className="sa-form-actions"><Button variant="outline" onClick={keep}>Keep editing</Button><Button onClick={()=>{const action=pending?.action;setPending(null);action?.()}}>Discard changes</Button></div></DialogContent></Dialog>
}
export function useUnsaved(dirty:boolean,message?:string,title?:string){
 const savedNavigation=useRef(false)
 const blocker=useBlocker(({currentLocation,nextLocation})=>!savedNavigation.current&&dirty&&(currentLocation.pathname+currentLocation.search!==nextLocation.pathname+nextLocation.search))
 useEffect(()=>{if(blocker.state==='blocked')confirmDiscard(message||'Your changes have not been saved. Discard them and open the selected page?',()=>blocker.proceed(),()=>blocker.reset(),title)},[blocker,message,title])
 useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault()};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)},[dirty])
 return useCallback((navigate:()=>void)=>{savedNavigation.current=true;try{navigate()}finally{savedNavigation.current=false}},[])
}
