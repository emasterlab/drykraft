import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorState, PageHeading } from '@/components/common'
import { useWorkspace } from '@/context'
import { api, send } from '@/lib/api'
import { FinanceSettings } from '@/pages/Finance'
import { PurchaseOrders } from '@/pages/PurchaseOrders'

export function FinanceFallback() {
  const location=useLocation()
  if(location.pathname==='/finance/purchase-orders')return <PurchaseOrders/>
  if(location.pathname==='/finance/settings')return <><FinanceSettings/><PurchaseOrderSettings/></>
  return <PageHeading title="Finance page not found" description="Choose a Finance page from the menu to continue."><Button variant="outline" asChild><Link to="/finance/overview">Finance overview</Link></Button></PageHeading>
}

function PurchaseOrderSettings() {
  const {session,notify}=useWorkspace(),admin=['owner','admin'].includes(session.role)
  const [profile,setProfile]=useState<Record<string,string>|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  useEffect(()=>{api<Record<string,string>>('/finance/profile').then(setProfile).catch(e=>setError(e.message))},[])
  return <><PageHeading title="Purchase order numbering" description="Choose the prefix used when a purchase order is issued."/>{error&&<ErrorState message={error}/>}<section className="settings-section"><form className="stack-form" onSubmit={async event=>{event.preventDefault();if(!profile)return;setBusy(true);setError('');try{await send('/finance/profile',profile,'PUT');notify('Purchase order prefix saved')}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}><label>Purchase order prefix<Input required maxLength={12} pattern="[A-Z0-9-]{1,12}" value={profile?.purchase_order_prefix||'PO'} onChange={event=>setProfile(current=>({...current!,purchase_order_prefix:event.target.value.toUpperCase()}))}/><small>Numbers follow this prefix, for example PO-2026-00001. Use 1-12 uppercase letters, numbers, or hyphens.</small></label>{admin&&<Button type="submit" disabled={!profile||busy}>{busy?'Saving...':'Save prefix'}</Button>}{!admin&&<p className="settings-note">Ask a workspace administrator to change this prefix.</p>}</form></section></>
}
