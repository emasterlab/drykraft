import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ClipboardList, Plus, Search, ChevronLeft, ChevronRight, Download, FileText, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { EmptyState, ErrorState, LoadingPage, NativeSelect, PageHeading, Status } from '@/components/common'
import { RelationField } from '@/components/RelationField'
import { RelatedRecords } from '@/components/RelatedRecords'
import { CustomField } from '@/pages/Finance'
import { useWorkspace } from '@/context'
import { api, humanDate, send, type RecordItem } from '@/lib/api'

const today = () => new Date().toISOString().slice(0, 10)
const digits = (currency: string) => new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits!
const money = (minor: number | string, currency: string) => new Intl.NumberFormat('en', { style: 'currency', currency }).format(Number(minor || 0) / 10 ** digits(currency))
const dateIn30Days = () => new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
const editableKeys = ['name', 'vendor', 'vendor_email', 'vendor_address', 'company_id', 'deal_id', 'currency', 'order_date', 'expected_date', 'items', 'notes']
const blankLine = () => ({ description: '', quantity: '1', unit_price: '', discount: '0', tax_rate: '0' })

export function PurchaseOrders() {
  const { session } = useWorkspace()
  const [items, setItems] = useState<RecordItem[]>([]), [total, setTotal] = useState(0), [next, setNext] = useState<string | null>(null), [cursor, setCursor] = useState<string | null>(null), [previous, setPrevious] = useState<string[]>([])
  const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [status, setStatus] = useState(''), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [active, setActive] = useState<RecordItem | null>(null), [open, setOpen] = useState(false), [params, setParams] = useSearchParams()
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setCursor(null); setPrevious([]) }, 250); return () => clearTimeout(timer) }, [search])
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api<{items:RecordItem[];total:number;next_cursor:string|null}>(`/records/purchase_orders?limit=25&search=${encodeURIComponent(query)}${status ? `&status=${encodeURIComponent(status)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      setItems(result.items); setTotal(result.total); setNext(result.next_cursor); setError('')
    } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }, [query, status, cursor])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const id=params.get('record')
    if(id){void api<RecordItem>(`/records/purchase_orders/${id}`).then(record=>{setActive(record);setOpen(true);setParams({}, {replace:true})}).catch(e=>{setError((e as Error).message);setParams({}, {replace:true})})}
    else if(params.get('new')==='1'){setActive(null);setOpen(true);setParams({}, {replace:true})}
  }, [params, setParams])
  const page = previous.length + 1
  return <>
    <PageHeading title="Purchase Orders" description="Prepare supplier orders, issue a numbered PO, and keep its terms and totals with the vendor record.">
      {session.role !== 'viewer' && <Button onClick={() => { setActive(null); setOpen(true) }}><Plus size={15} />Create purchase order</Button>}
    </PageHeading>
    {error && <ErrorState message={error} retry={() => void load()} />}
    <section className="records-panel">
      <div className="records-toolbar">
        <div className="record-search"><Search size={16} /><Input aria-label="Search purchase orders" placeholder="Search PO or supplier..." value={search} onChange={e => setSearch(e.target.value)} /></div>
        <NativeSelect className="finance-filter" aria-label="Filter purchase orders by status" value={status} onChange={e => { setStatus(e.target.value); setCursor(null); setPrevious([]) }}><option value="">All statuses</option>{['Draft', 'Issued', 'Cancelled'].map(value => <option key={value}>{value}</option>)}</NativeSelect>
      </div>
      {loading ? <div className="table-loading"><LoadingPage /></div> : items.length ? <div className="table-scroll" tabIndex={0} role="region" aria-label="Scrollable purchase orders table"><table className="data-table"><thead><tr><th>Purchase order</th><th>Supplier</th><th>Status</th><th>Order date</th><th>Total</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>{items.map(record => <tr key={record.id}>
        <td><button className="record-name-cell" onClick={() => { setActive(record); setOpen(true) }}><span className="record-avatar"><ClipboardList size={15} /></span><span><strong>{record.data.po_number || record.data.name}</strong>{record.data.po_number && <small className="finance-table-subtitle">{record.data.name}</small>}</span></button></td>
        <td>{record.data.vendor}</td><td><Status value={record.data.status} /></td><td>{humanDate(record.data.order_date)}</td><td className="tabular-nums">{money(record.data.total_minor, record.data.currency)}</td>
        <td><Button variant="ghost" size="icon-sm" aria-label={`Open ${record.data.name}`} onClick={() => { setActive(record); setOpen(true) }}><ChevronRight size={15} /></Button></td>
      </tr>)}</tbody></table></div> : <EmptyState icon={ClipboardList} title={query || status ? 'No matching purchase orders' : 'Create your first purchase order'} description={query || status ? 'Try another search or status.' : 'Add a supplier and line items, then save a draft or issue a numbered PDF.'} />}
      <div className="table-footer"><span>{total ? `${previous.length * 25 + 1}–${Math.min(previous.length * 25 + items.length, total)} of ${total}` : '0 records'}</span><div><Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={!previous.length || loading} onClick={() => { setCursor(previous.at(-1) || null); setPrevious(value => value.slice(0, -1)) }}><ChevronLeft size={15} /></Button><span>Page {page}</span><Button variant="outline" size="icon-sm" aria-label="Next page" disabled={!next || loading} onClick={() => { if (next) { setPrevious(value => [...value, cursor || '']); setCursor(next) } }}><ChevronRight size={15} /></Button></div></div>
    </section>
    <PurchaseOrderSheet key={active?.id || (open ? 'new' : 'closed')} record={active} open={open} onOpenChange={setOpen} onSaved={record => { setActive(record); void load() }} />
  </>
}

function PurchaseOrderSheet({ record, open, onOpenChange, onSaved }: {record:RecordItem|null;open:boolean;onOpenChange:(open:boolean)=>void;onSaved:(record:RecordItem)=>void}) {
  const { session, objects, notify } = useWorkspace(), admin = ['owner', 'admin'].includes(session.role), write = session.role !== 'viewer'
  const customFields=useMemo(()=>objects.find(object=>object.key==='purchase_orders')?.fields.filter(field=>!editableKeys.includes(field.key)&&!['po_number','status','issued_at','cancelled_at','cancel_reason','subtotal_minor','discount_minor','tax_minor','total_minor','issuer'].includes(field.key))||[],[objects])
  const fields=useMemo(()=>[...editableKeys,...customFields.map(field=>field.key)],[customFields])
  const currencyList = useMemo(() => [...new Set([...(session.workspace.settings.currencies || [session.workspace.settings.currency || 'USD']), ...(record ? [record.data.currency] : [])])], [session.workspace.settings.currencies, session.workspace.settings.currency, record])
  const [data, setData] = useState<Record<string, any>>({}), [busy, setBusy] = useState(false), [error, setError] = useState(''), [action, setAction] = useState(''), [reason, setReason] = useState('')
  const baseline = useMemo(() => record ? Object.fromEntries(fields.map(key => [key, record.data[key] ?? (key === 'items' ? [] : '')])) : null, [record,fields])
  const dirty = !!record && JSON.stringify(Object.fromEntries(fields.map(key => [key, data[key] ?? (key === 'items' ? [] : '')]))) !== JSON.stringify(baseline)
  const currency = data.currency || session.workspace.settings.currency || 'USD', currencyDigits = digits(currency)
  const totals = useMemo(() => {
    let subtotal = 0, discount = 0, tax = 0
    for (const item of data.items || []) {
      const gross = Number(item.quantity || 0) * Number(item.unit_price || 0), off = Number(item.discount || 0)
      subtotal += Math.round(gross * 10 ** currencyDigits); discount += Math.round(off * 10 ** currencyDigits)
      tax += Math.round(Math.max(0, gross - off) * Number(item.tax_rate || 0) / 100 * 10 ** currencyDigits)
    }
    return { subtotal, discount, tax, total: subtotal - discount + tax }
  }, [data.items, currencyDigits])
  useEffect(() => {
    if (!open) return
    setData(record?.data || { name: '', vendor: '', vendor_email: '', vendor_address: '', currency: session.workspace.settings.currency || 'USD', order_date: today(), expected_date: dateIn30Days(), items: [blankLine()], notes: '' })
    setError(''); setAction(''); setReason('')
  }, [open, record, session.workspace.settings.currency])
  const update = (key: string, value: any) => setData(current => ({ ...current, [key]: value }))
  const field = (key: string, label: string, type = 'text', required = false) => <label key={key}>{label}<Input type={type} required={required} maxLength={2000} value={data[key] ?? ''} onChange={event => update(key, event.target.value)} /></label>
  async function save(issue = false) {
    setBusy(true); setError('')
    try {
      const payload = Object.fromEntries(fields.filter(key => key !== 'items').map(key => [key, data[key] ?? '']).filter(([, value]) => value !== '')) as Record<string, any>
      payload.items = (data.items || []).map((item:Record<string,string>) => ({description:item.description,quantity:item.quantity||'0',unit_price:item.unit_price||'0',discount:item.discount||'0',tax_rate:item.tax_rate||'0'}))
      let saved = record ? await send<RecordItem>(`/finance/purchase_orders/${record.id}`, {data:payload,version:record.version}, 'PUT') : await send<RecordItem>('/finance/purchase_orders', {data:payload})
      if (issue) saved = await send<RecordItem>(`/finance/purchase_orders/${saved.id}/action`, {action:'issue',version:saved.version})
      onSaved(saved); notify(issue ? `Purchase order ${saved.data.po_number} issued` : 'Purchase order draft saved')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function transition(event:React.FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setError(''); try { const updated=await send<RecordItem>(`/finance/purchase_orders/${record!.id}/action`,{action:'cancel',version:record!.version,note:reason});setAction('');onSaved(updated);notify('Purchase order cancelled') } catch(e) { setError((e as Error).message) } finally { setBusy(false) } }
  const editable = write && (!record || record.data.status === 'Draft')
  return <>
    <Sheet open={open} onOpenChange={onOpenChange}><SheetContent className="record-sheet finance-sheet"><SheetHeader><SheetTitle>{record?.data.po_number || (record ? record.data.name : 'New purchase order')}</SheetTitle><SheetDescription>{record ? 'Supplier details, order totals, and next steps.' : 'Set up a supplier order and prepare it for issue.'}</SheetDescription></SheetHeader>
      <div className="record-sheet-body">{error && <ErrorState message={error} />}{record && <div className="finance-document-summary"><Status value={record.data.status} /><strong>{money(record.data.total_minor, record.data.currency)}</strong></div>}
        <form id="purchase-order-form" className="stack-form" onSubmit={event => {event.preventDefault();void save()}}><fieldset disabled={!editable || busy}>
          {field('name','Purchase order title','text',true)}
          <div className="form-grid"><label>Currency<NativeSelect value={currency} onChange={event => update('currency',event.target.value)}>{currencyList.map(code=><option key={code} value={code}>{code} - {session.currency_options.find(option=>option.code===code)?.name||code}</option>)}</NativeSelect></label><RelationField label="Linked deal" object="deals" value={data.deal_id||''} disabled={!editable||busy} onChange={value=>update('deal_id',value)} /></div>
          <RelationField label="Vendor company" object="companies" value={data.company_id||''} disabled={!editable||busy} onChange={(id,company)=>setData(current=>({...current,company_id:id,...(company?{vendor:company.data.name,vendor_email:company.data.email||current.vendor_email,vendor_address:company.data.address||current.vendor_address}:{})}))} />
          <div className="form-grid">{field('vendor','Supplier name','text',true)}{field('vendor_email','Supplier email','email')}</div>
          <label>Supplier address<Textarea maxLength={2000} value={data.vendor_address||''} onChange={event=>update('vendor_address',event.target.value)} /></label>
          <div className="form-grid">{field('order_date','Order date','date',true)}{field('expected_date','Expected delivery','date')}</div>
          <div className="finance-lines"><div className="finance-section-heading"><h3>Line items</h3><span>Amounts in {currency}</span></div>{(data.items||[]).map((item:Record<string,string>,index:number)=><div className="finance-line" key={index}>
            <label>Description<Input aria-label={`Line ${index+1} description`} required maxLength={500} value={item.description||''} onChange={event=>update('items',data.items.map((value:Record<string,string>,row:number)=>row===index?{...value,description:event.target.value}:value))}/></label>
            <div className="finance-line-values">{[['quantity','Quantity','0.001'],['unit_price','Unit price',String(1/10**currencyDigits)],['discount','Discount',String(1/10**currencyDigits)],['tax_rate','Tax %','0.01']].map(([key,label,step])=><label key={key}>{label}<Input aria-label={`Line ${index+1} ${label.toLowerCase()}`} type="number" min={key==='quantity'?step:0} max={key==='tax_rate'?100:undefined} step={step} required value={item[key]??'0'} onChange={event=>update('items',data.items.map((value:Record<string,string>,row:number)=>row===index?{...value,[key]:event.target.value}:value))}/></label>)}{editable&&<Button variant="ghost" size="icon" type="button" aria-label={`Remove line ${index+1}`} disabled={data.items.length===1} onClick={()=>update('items',data.items.filter((_:unknown,row:number)=>row!==index))}><X size={15}/></Button>}</div>
          </div>)}{editable&&<Button type="button" variant="outline" size="sm" disabled={data.items?.length>=100} onClick={()=>update('items',[...data.items,blankLine()])}><Plus size={14}/>Add line item</Button>}</div>
          <label>Notes<Textarea maxLength={2000} value={data.notes||''} onChange={event=>update('notes',event.target.value)}/></label>
          {customFields.length>0&&<h3 className="finance-section-heading">Custom fields</h3>}{customFields.map(field=><CustomField key={field.key} field={field} value={data[field.key]} onChange={value=>update(field.key,value)}/>)}
        </fieldset></form>
        <div className="finance-totals">{[['Subtotal',totals.subtotal],['Discount',totals.discount],['Tax',totals.tax],['Order total',totals.total]].map(([label,value])=><div key={label}><span>{label}</span><strong>{money(Number(value),currency)}</strong></div>)}</div>
        {record?.data.cancel_reason&&<p className="finance-decision">Cancellation reason: {record.data.cancel_reason}</p>}
        {editable&&dirty&&<p className="finance-decision">Save your draft changes before issuing this purchase order.</p>}
        {record&&<div className="finance-next-actions">{!dirty&&<Button variant="outline" asChild><a href={`/api/finance/purchase-orders/${record.id}/pdf`} download><Download size={15}/>Download PDF</a></Button>}{write&&record.data.status==='Draft'&&<Button disabled={busy||dirty} onClick={()=>void save(true)}>Issue purchase order</Button>}{write&&['Draft','Issued'].includes(record.data.status)&&<Button variant="outline" disabled={busy||dirty||(record.data.status==='Issued'&&!admin)} onClick={()=>{setReason('');setError('');setAction('cancel')}}>Cancel purchase order</Button>}</div>}
        {record&&<RelatedRecords record={record}/ >}
      </div><div className="record-sheet-footer"><Button variant="outline" onClick={()=>onOpenChange(false)}>Close</Button>{editable&&<><Button variant="outline" form="purchase-order-form" type="submit" disabled={busy}>{busy?'Saving...':'Save draft'}</Button><Button form="purchase-order-form" type="button" disabled={busy} onClick={()=>{const form=document.getElementById('purchase-order-form') as HTMLFormElement|null;if(form?.reportValidity())void save(true)}}>{busy?'Saving...':'Save and issue'}</Button></>}</div></SheetContent></Sheet>
    <Dialog open={action==='cancel'} onOpenChange={value=>{if(!value){setAction('');setError('')}}}><DialogContent><DialogTitle>Cancel this purchase order?</DialogTitle><DialogDescription>{record?.data.status==='Issued'?'The issued order will remain in your history with its cancellation reason.':'The draft will be marked cancelled and kept in your history.'}</DialogDescription><form className="stack-form" onSubmit={transition}><label>Reason<Textarea required minLength={1} maxLength={2000} value={reason} onChange={event=>setReason(event.target.value)}/></label>{error&&<ErrorState message={error}/>}<div className="dialog-actions"><Button variant="outline" type="button" onClick={()=>setAction('')}>Keep order</Button><Button type="submit" disabled={busy}>Confirm cancellation</Button></div></form></DialogContent></Dialog>
  </>
}
