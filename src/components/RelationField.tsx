import {useEffect,useId,useState} from 'react'
import {Link} from 'react-router-dom'
import {api,type RecordItem} from '@/lib/api'
import {recordUrl} from '@/lib/record-links'
import {useWorkspace} from '@/context'
import {Input} from '@/components/ui/input'
import {Button} from '@/components/ui/button'
import {NativeSelect} from '@/components/common'

type Options={object:string;items:RecordItem[];selected:RecordItem|null;next_cursor:string|null;total:number}
export function RelationField({label,value='',object,required=false,disabled=false,onChange}:{label:string;value?:string;object?:string;required?:boolean;disabled?:boolean;onChange:(id:string,record?:RecordItem)=>void}){
 const id=useId(),{objects,session}=useWorkspace(),[key,setKey]=useState(object || ''),[search,setSearch]=useState(''),[query,setQuery]=useState(''),[pages,setPages]=useState<string[]>([]),[result,setResult]=useState<Options|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0)
 useEffect(()=>{const t=setTimeout(()=>{setQuery(search);setPages([])},250);return()=>clearTimeout(t)},[search])
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError('')
  const p=new URLSearchParams({search:query});if(object || key && !value)p.set('object',object || key);if(value)p.set('selected',value);if(pages.length)p.set('cursor',pages.at(-1)!)
  api<Options>(`/record-options?${p}`,{signal:controller.signal}).then(r=>{setResult(r);if(!object && key!==r.object)setKey(r.object)}).catch(e=>{if(e.name!=='AbortError')setError(e.message)}).finally(()=>{if(!controller.signal.aborted)setLoading(false)})
  return()=>controller.abort()
 },[object,key,value,query,pages,retry,session.workspace.id])
 const selected=result?.selected?.id===value?result.selected:result?.items.find(r=>r.id===value),items=result?.items || []
 const optionName=(r:RecordItem)=>[r.data.name,r.data.email].filter(Boolean).join(' - ')
 return <div className="relation-picker"><label htmlFor={id}>{label}{required&&<span className="required-mark"> *</span>}</label>{!object&&<NativeSelect aria-label={`Record type for ${label}`} value={key || 'people'} disabled={disabled} onChange={e=>{setKey(e.target.value);setSearch('');setQuery('');setPages([]);setResult(null);onChange('')}}>{objects.map(o=><option key={o.key} value={o.key}>{o.name}</option>)}</NativeSelect>}<Input type="search" aria-label={`Search records for ${label}`} maxLength={200} value={search} disabled={disabled} placeholder="Search by name or email" onChange={e=>setSearch(e.target.value)}/><NativeSelect id={id} value={value} required={required} disabled={disabled} onChange={e=>{const r=items.find(v=>v.id===e.target.value);onChange(e.target.value,r)}}><option value="">{loading?'Loading records...':'No linked record'}</option>{value&&!items.some(r=>r.id===value)&&<option value={value}>{selected?optionName(selected):'Saved record reference'}</option>}{items.map(r=><option key={r.id} value={r.id}>{optionName(r)}</option>)}</NativeSelect>{selected&&<Link className="relation-open" to={recordUrl(selected.object_key,selected.id)}>Open {selected.data.name}</Link>}<div className="relation-picker-tools">{!!pages.length&&<Button type="button" size="sm" variant="ghost" disabled={disabled||loading} onClick={()=>setPages(p=>p.slice(0,-1))}>Previous records</Button>}{result?.next_cursor&&<Button type="button" size="sm" variant="ghost" disabled={disabled||loading} onClick={()=>setPages(p=>[...p,result.next_cursor!])}>More records</Button>}{error&&<Button type="button" variant="outline" size="sm" disabled={disabled||loading} onClick={()=>setRetry(v=>v+1)}>Retry records</Button>}</div>{!loading&&!error&&!items.length&&<small>No records match. Try another search.</small>}{error&&<p role="alert" className="form-error">{error}</p>}</div>
}
