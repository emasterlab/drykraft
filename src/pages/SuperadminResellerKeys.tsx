import {useEffect,useRef,useState} from 'react'
import {NavLink,Route,Routes,useNavigate,useParams,useSearchParams} from 'react-router-dom'
import {ArrowLeft,Copy,RefreshCw} from 'lucide-react'
import {Button} from '@/components/ui/button'
import {Input,PasswordField} from '@/components/ui/input'
import {ErrorState} from '@/components/common'
import {Dialog,DialogContent,DialogDescription,DialogTitle} from '@/components/ui/dialog'
import {ApiError} from '@/lib/api'
import {request,useData,Loading,Field,Notice,date,useUnsaved} from './SuperadminShared'
import {Reason} from './SuperadminCommercial'

type Key={id:string;reseller_id:string;name:string;prefix:string;scopes:string[];expires_at:string;revoked_at:string|null;version:number;created_by:string;created_at:string}
type Result={key:Key;secret:string|null;replayed:boolean}
type Props={resellerId:string;resellerName:string;resellerKey:string;available:boolean;role:string}
const permissions=[
 ['reseller.customers.read','Customer directory','Linked workspace names, addresses and assigned retail versions.'],
 ['reseller.plans.read','Retail catalog','Own catalog prices and current immutable plan definitions.'],
 ['reseller.usage.read','Resource allowances','Own aggregate resource counts and current wholesale ceilings.'],
] as const
const permissionName=(scope:string)=>permissions.find(p=>p[0]===scope)?.[1]||scope
const status=(key:Key)=>key.revoked_at?'Revoked':new Date(key.expires_at)<=new Date()?'Expired':'Active'
const apiBase=(p:Props)=>'/resellers/'+p.resellerId+'/api-keys'
const urlBase=(p:Props)=>'/sa/resellers/'+p.resellerId+'/api-keys'
const localTime=(date:Date)=>{const shifted=new Date(date.getTime()-date.getTimezoneOffset()*60000);return shifted.toISOString().slice(0,16)}
const denied=(e:unknown)=>e instanceof ApiError&&e.status>=400&&e.status<500&&e.status!==408

export function ResellerKeys(p:Props){
 if(!['owner','admin','viewer'].includes(p.role))return <ErrorState message="Your platform role cannot inspect reseller API keys."/>
 const manager=['owner','admin'].includes(p.role)
 return <Routes><Route index element={<KeyList {...p} manager={manager}/>}/><Route path="new" element={manager?<KeyCreate {...p}/>:<ErrorState message="Only a platform owner or administrator can issue keys."/>}/><Route path=":keyId" element={<KeyDetail {...p} manager={manager}/>}/><Route path="*" element={<ErrorState message="This API key page does not exist. Open the key directory."/>}/></Routes>
}
function KeyList(p:Props&{manager:boolean}){
 const [cursor,setCursor]=useState(''),[history,setHistory]=useState<string[]>([])
 const saved=useData<{items:Key[];next_cursor:string|null}>(apiBase(p)+(cursor?'?cursor='+cursor:''))
 return <><div className="sa-commercial-heading"><div><h2>API keys</h2><p>Scoped integration access to this reseller’s metadata.</p></div><div className="sa-form-actions"><Button variant="outline" onClick={saved.reload}><RefreshCw size={15}/>Refresh keys</Button>{p.manager&&p.available&&<Button asChild><NavLink to={urlBase(p)+'/new'}>Create API key</NavLink></Button>}</div></div>
 {!p.available&&<Notice>New keys require an approved reseller with a current contract. Existing keys remain inspectable and can be revoked.</Notice>}
 {saved.error?<ErrorState message={saved.error} retry={saved.reload}/>:saved.loading?<Loading/>:saved.data&&<><div className="sa-table-scroll" role="region" aria-label="Reseller API keys" tabIndex={0}><table className="sa-table"><thead><tr><th>Name</th><th>Prefix</th><th>Permissions</th><th>Key status</th><th>Expires</th></tr></thead><tbody>{saved.data.items.map(k=><tr key={k.id}><td><NavLink to={urlBase(p)+'/'+k.id}>{k.name}</NavLink></td><td><code>{k.prefix}</code></td><td>{k.scopes.map(permissionName).join(', ')}</td><td>{status(k)}</td><td>{date(k.expires_at)}</td></tr>)}</tbody></table></div>
 {!saved.data.items.length&&<div className="sa-empty"><h3>No API keys yet</h3><p>Create a key for a specific integration, select its read permissions and set an expiry.</p></div>}
 <div className="sa-pagination"><Button variant="outline" disabled={!history.length} onClick={()=>{setCursor(history.at(-1)||'');setHistory(history.slice(0,-1))}}>Previous page</Button><span>Up to 25 keys per page</span><Button variant="outline" disabled={!saved.data.next_cursor} onClick={()=>{setHistory([...history,cursor]);setCursor(saved.data!.next_cursor||'')}}>Next page</Button></div></>}
 <Notice>A key never grants customer CRM, finance, workspace-user or platform account access. An active contract, expiry and revocation are checked on every request.</Notice></>
}
function Facts({value,organization}:{value:Key;organization?:string}){
 return <dl className="sa-facts">{organization&&<><dt>Reseller</dt><dd>{organization}</dd></>}<dt>Key name</dt><dd>{value.name}</dd><dt>Prefix</dt><dd><code>{value.prefix}</code></dd><dt>Key status</dt><dd>{status(value)}</dd><dt>Revision</dt><dd>{value.version}</dd><dt>Permissions</dt><dd>{value.scopes.map(permissionName).join(', ')}</dd><dt>Expires</dt><dd>{date(value.expires_at)}</dd>{value.revoked_at&&<><dt>Revoked</dt><dd>{date(value.revoked_at)}</dd></>}</dl>
}
function KeyCreate(p:Props){
 const navigate=useNavigate(),[params,setParams]=useSearchParams()
 const [requestId]=useState(()=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(params.get('request')||'')?params.get('request')!:crypto.randomUUID())
 const [initialExpiry]=useState(()=>localTime(new Date(Date.now()+30*86400000))),[expires,setExpires]=useState(initialExpiry),[name,setName]=useState(''),[scopes,setScopes]=useState<string[]>([]),[reason,setReason]=useState('')
 const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false),[recovering,setRecovering]=useState(true),[recoveryError,setRecoveryError]=useState(''),[retry,setRetry]=useState(0),[result,setResult]=useState<Result|null>(null),[ack,setAck]=useState(false),[copied,setCopied]=useState(false)
 const pending=useRef<Record<string,unknown>|null>(null),dirty=!!(name||reason||scopes.length)||expires!==initialExpiry
 const navigateSaved=useUnsaved(result?!!result.secret&&!ack:dirty,result?'The key has been created. Leaving discards the secret shown here; it cannot be recovered. Leaving does not revoke the key.':undefined,result?'Discard this key copy?':undefined)
 useEffect(()=>{if(params.get('request')!==requestId)setParams({request:requestId},{replace:true})},[params,requestId,setParams])
 useEffect(()=>{let mounted=true;setRecovering(true);setRecoveryError('');request<Result>(apiBase(p)+'/creations/'+requestId).then(v=>{if(mounted)setResult(v)}).catch(e=>{if(mounted&&!(e instanceof ApiError&&e.status===404))setRecoveryError(e.message)}).finally(()=>{if(mounted)setRecovering(false)});return()=>{mounted=false}},[p.resellerId,requestId,retry])
 async function save(){
  setBusy(true);setError('');const body=pending.current||{name,scopes:[...scopes].sort(),expires_at:new Date(expires).toISOString(),reason,request_id:requestId};pending.current=body
  try{
   if(uncertain){try{const saved=await request<Result>(apiBase(p)+'/creations/'+requestId);setResult(saved);setConfirm(false);setUncertain(false);return}catch(e){if(!(e instanceof ApiError&&e.status===404))throw e}}
   const saved=await request<Result>(apiBase(p),body);setResult(saved);setConfirm(false);setUncertain(false)
  }catch(e){if(denied(e)){pending.current=null;setUncertain(false);setError((e as Error).message)}else{setUncertain(true);setError('The result could not be confirmed. Check this saved request before issuing another key. '+(e as Error).message)}}finally{setBusy(false)}
 }
 async function copy(){try{await navigator.clipboard.writeText(result!.secret!);setCopied(true);setError('')}catch{setError('Copy was unavailable. Use the eye control to reveal and copy the key manually.')}}
 if(recovering)return <Loading/>
 if(recoveryError)return <ErrorState message={'Check this request before continuing. '+recoveryError} retry={()=>setRetry(n=>n+1)}/>
 if(result)return <><NavLink className="sa-back" to={urlBase(p)}><ArrowLeft size={15}/>API keys</NavLink><div className="sa-commercial-heading"><div><h2>{result.secret?'Save your API key':'Saved API key recovered'}</h2><p>{result.secret?'This is the only time its secret is available.':'The secret cannot be shown again.'}</p></div></div><section className="sa-key-result"><Facts value={result.key} organization={p.resellerName}/>
 {result.secret?<><PasswordField fieldClassName="sa-field" label="Generated API key" value={result.secret} readOnly autoComplete="off"/><Button variant="outline" onClick={()=>void copy()}><Copy size={15}/>{copied?'Copied':'Copy API key'}</Button><Notice>Store this in your integration’s private secret settings. The browser keeps this copy only on this page.</Notice><label className="sa-checkbox"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>I saved this key securely</label></>:<Notice>If the original secret was lost, open the key details, revoke this key and explicitly create a replacement. Repeating this saved request never returns another secret.</Notice>}
 {error&&<ErrorState message={error}/>}<div className="sa-form-actions"><Button disabled={!!result.secret&&!ack} onClick={()=>navigateSaved(()=>navigate(urlBase(p)+'/'+result.key.id,{replace:true}))}>Open key details</Button></div></section></>
 return <><NavLink className="sa-back" to={urlBase(p)}><ArrowLeft size={15}/>API keys</NavLink><h2>Create API key</h2><p className="sa-commercial-context">For {p.resellerName} ({p.resellerKey}). Choose only the metadata this integration needs.</p>
 {!p.available&&<Notice>This reseller needs approval and a current contract before a new key can be issued.</Notice>}
 <form className="sa-form" onSubmit={e=>{e.preventDefault();setError('');if(!scopes.length){setError('Choose at least one read permission.');return}const expiry=new Date(expires).getTime();if(!Number.isFinite(expiry)||expiry<=Date.now()||expiry>Date.now()+90*86400000){setError('Choose a future expiry within 90 days.');return}setConfirm(true)}}><fieldset disabled={busy||uncertain||!p.available}><Field label="Key name"><Input value={name} onChange={e=>setName(e.target.value)} minLength={2} maxLength={100} required placeholder="Reporting integration"/><small>Identify the integration using this key.</small></Field>
 <fieldset className="sa-key-scopes"><legend>Read permissions</legend>{permissions.map(([scope,label,description])=><label className="sa-checkbox" key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={e=>setScopes(e.target.checked?[...scopes,scope]:scopes.filter(v=>v!==scope))}/><span><strong>{label}</strong><small>{description}</small></span></label>)}</fieldset>
 <Notice>Own reseller identity metadata is available to every active key. These permissions add no write or customer CRM access.</Notice><Field label="Expires"><Input type="datetime-local" value={expires} onChange={e=>setExpires(e.target.value)} required min={localTime(new Date(Date.now()+60000))} max={localTime(new Date(Date.now()+90*86400000))}/><small>Your local time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Maximum 90 days.</small></Field><Reason value={reason} onChange={setReason}/>{error&&!confirm&&<ErrorState message={error}/>}<Button type="submit">Review API key</Button></fieldset></form>
 {uncertain&&<><Notice>The submitted setup is locked until its result is checked. If no saved receipt exists, the identical request can be repeated safely.</Notice><Button onClick={()=>setConfirm(true)}>Check saved key</Button></>}
 <Dialog open={confirm} onOpenChange={v=>{if(!busy)setConfirm(v)}}><DialogContent className="sa-commercial-dialog"><DialogTitle>Issue {name}?</DialogTitle><DialogDescription>Review this integration’s access before generating its one-time secret.</DialogDescription><dl className="sa-facts"><dt>Reseller</dt><dd>{p.resellerName} ({p.resellerKey})</dd><dt>Key name</dt><dd>{name}</dd><dt>Permissions</dt><dd>{scopes.map(permissionName).join(', ')}</dd><dt>Expires</dt><dd>{Number.isFinite(new Date(expires).getTime())?date(new Date(expires).toISOString()):'Choose an expiry'}</dd></dl><p className="sa-review-reason"><strong>Reason:</strong> {reason}</p><Notice>Save the secret after confirmation. Permission and expiry changes require a replacement key; this setup does not send the key to anyone.</Notice>{error&&<ErrorState message={error}/>}<div className="sa-form-actions"><Button variant="outline" disabled={busy} onClick={()=>setConfirm(false)}>{uncertain?'Close review':'Back to editing'}</Button><Button disabled={busy} onClick={()=>void save()}>{busy?'Checking...':uncertain?'Check then repeat same request':'Generate API key'}</Button></div></DialogContent></Dialog></>
}
function KeyDetail(p:Props&{manager:boolean}){
 const {keyId}=useParams();return <SavedKey key={keyId} {...p} keyId={keyId!}/>
}
function SavedKey(p:Props&{manager:boolean;keyId:string}){
 const saved=useData<Key>(apiBase(p)+'/'+p.keyId),[reason,setReason]=useState(''),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('')
 const clearGuard=useUnsaved(!!reason&&!saved.data?.revoked_at)
 async function revoke(){setBusy(true);setError('');try{
  if(uncertain){const current=await request<Key>(apiBase(p)+'/'+p.keyId);saved.setData(current);setConfirm(false);setUncertain(false);if(current.revoked_at){clearGuard(()=>setReason(''));setMessage('Saved key is revoked. The original secret is no longer accepted.')}else setError('The saved key is still active. Review its current revision before submitting another revocation.');return}
  const current=await request<Key>(apiBase(p)+'/'+p.keyId,{version:saved.data!.version,reason},'PUT');saved.setData(current);clearGuard(()=>setReason(''));setConfirm(false);setMessage('Key revoked. The original secret is no longer accepted.')
 }catch(e){setError((e as Error).message);if(!denied(e))setUncertain(true)}finally{setBusy(false)}}
 return <><NavLink className="sa-back" to={urlBase(p)}><ArrowLeft size={15}/>API keys</NavLink>{saved.error?<ErrorState message={saved.error} retry={saved.reload}/>:saved.loading?<Loading/>:saved.data&&<><div className="sa-commercial-heading"><div><h2>{saved.data.name}</h2><p>Saved integration access for {p.resellerName}.</p></div><Button variant="outline" disabled={busy||uncertain} onClick={saved.reload}><RefreshCw size={15}/>Reload saved key</Button></div>{message&&<p role="status" className="sa-commercial-context">{message}</p>}<div className="sa-details"><section className="sa-section"><Facts value={saved.data}/><Notice>The secret is never returned from this page. Scope and expiry are immutable. Revocation keeps the key’s metadata and audit history.</Notice>
 {p.manager&&!saved.data.revoked_at&&<form className="sa-form" onSubmit={e=>{e.preventDefault();setError('');setConfirm(true)}}><fieldset disabled={busy||uncertain}><h2>Revoke this key</h2><Notice>Revocation also works after a contract pause or expiry. Requests already accepted may finish; subsequent requests fail.</Notice><Reason value={reason} onChange={setReason}/><Button type="submit">Review revocation</Button></fieldset></form>}
 {uncertain&&<><Notice>The revocation result is unknown. Check this key’s saved status before repeating the action.</Notice><Button onClick={()=>setConfirm(true)}>Check saved revocation</Button></>}{error&&!confirm&&<ErrorState message={error}/>}</section><aside className="sa-section"><h2>Integration use</h2><Notice>Use this key only with the scoped reseller API on app.drykraft.com. Identity, contract and permissions are checked for every read.</Notice><Button asChild variant="outline" className="sa-section-action"><a href="https://drykraft.com/docs/api/reseller-api" target="_blank" rel="noreferrer">Open reseller API reference</a></Button></aside></div>
 <Dialog open={confirm} onOpenChange={v=>{if(!busy)setConfirm(v)}}><DialogContent className="sa-commercial-dialog"><DialogTitle>Revoke {saved.data.name}?</DialogTitle><DialogDescription>This permanently ends access through the selected key.</DialogDescription><Facts value={saved.data} organization={p.resellerName}/><p className="sa-review-reason"><strong>Reason:</strong> {reason}</p>{error&&<ErrorState message={error}/>}<div className="sa-form-actions"><Button variant="outline" disabled={busy} onClick={()=>setConfirm(false)}>{uncertain?'Close review':'Keep key active'}</Button><Button disabled={busy} onClick={()=>void revoke()}>{busy?'Checking...':uncertain?'Check saved status':'Confirm and revoke key'}</Button></div></DialogContent></Dialog></>}</>
}
