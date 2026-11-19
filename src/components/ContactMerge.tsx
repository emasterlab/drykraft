import { useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ErrorState, NativeSelect } from '@/components/common'
import { send, ApiError, type ObjectDefinition, type RecordItem } from '@/lib/api'

type Effects = { notes: number; relationships: number; financial_history: number; links: number; stopped_sequences: number }
type Preview = { data: Record<string, any>; effects: Effects; review_token: string }
const empty = (v: any) => v === undefined || v === null || v === '' || Array.isArray(v) && !v.length
function value(v: any, userName?: string): string { if (!empty(v) && userName) return userName; return empty(v) ? 'Empty' : typeof v === 'boolean' ? v ? 'Yes' : 'No' : typeof v === 'object' ? JSON.stringify(v) : String(v) }

export function ContactMerge({ definition, records, onClose, onMerged }: { definition: ObjectDefinition; records: RecordItem[]; onClose: () => void; onMerged: (r: RecordItem) => void }) {
  const [targetId, setTargetId] = useState(records[0].id), [takeSource, setTakeSource] = useState<string[]>([])
  const [preview, setPreview] = useState<Preview | null>(null), [operationId, setOperationId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false)
  const target = records.find(r => r.id === targetId)!, source = records.find(r => r.id !== targetId)!
  const input = { contacts: records.map(({ id, version }) => ({ id, version })), target_id: targetId, take_source: takeSource }
  const fields = definition.fields.filter(f => !['consent', 'tags'].includes(f.key) && (!empty(target.data[f.key]) || !empty(source.data[f.key])))
  async function review() {
    setBusy(true); setError(''); setPreview(null)
    try { const result = await send<Preview>('/record-tools/people/merge/preview', input); setPreview(result); setOperationId(crypto.randomUUID()); setStale(false) }
    catch (e) { setError((e as Error).message); setStale(e instanceof ApiError && e.status === 409) } finally { setBusy(false) }
  }
  async function merge() {
    if (!preview) return
    setBusy(true); setError('')
    try { const result = await send<{ record: RecordItem }>('/record-tools/people/merge/commit', { ...input, id: operationId, review_token: preview.review_token, confirmed: true }); onMerged(result.record) }
    catch (e) { setError((e as Error).message); setStale(e instanceof ApiError && e.status === 409) } finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={v => { if (!v && !busy) onClose() }}><DialogContent className="contact-merge-dialog" showCloseButton={!busy}>
    <div className="contact-merge-header"><DialogTitle>{preview ? 'Confirm contact merge' : 'Merge two contacts'}</DialogTitle><DialogDescription>{preview ? 'Check the remaining contact and the changes below before confirming.' : 'Choose the contact to keep, then compare the details. Nothing changes until you confirm.'}</DialogDescription></div>
    <div className="contact-merge-body stack-form" aria-busy={busy}>
      {error && <ErrorState message={error} />}
      {!preview ? <>
        <label>Remaining contact<NativeSelect value={targetId} disabled={busy} onChange={e => { setTargetId(e.target.value); setTakeSource([]); setError('') }}>{records.map(r => <option key={r.id} value={r.id}>{r.data.name} - {r.data.email || 'No email'}</option>)}</NativeSelect></label>
        <p className="contact-merge-help">Empty fields use the other contact’s details. Compare conflicting values below. All tags are combined.</p>
        <div className="contact-merge-fields">{fields.map(f => {
          const conflict = !empty(target.data[f.key]) && !empty(source.data[f.key]) && JSON.stringify(target.data[f.key]) !== JSON.stringify(source.data[f.key])
          return <div className="contact-merge-field" key={f.key}>
            <label htmlFor={conflict ? `merge-${f.key}` : undefined}>{f.name}</label>
            {conflict ? <><div className="contact-merge-values"><p><span>Remaining</span>{value(target.data[f.key], f.type === 'user' ? target.user_names?.[f.key] || 'Former member' : undefined)}</p><p><span>Other</span>{value(source.data[f.key], f.type === 'user' ? source.user_names?.[f.key] || 'Former member' : undefined)}</p></div><NativeSelect id={`merge-${f.key}`} aria-label={`${f.name} to keep`} disabled={busy} value={takeSource.includes(f.key) ? 'source' : 'target'} onChange={e => setTakeSource(v => e.target.value === 'source' ? [...v, f.key] : v.filter(k => k !== f.key))}><option value="target">Keep remaining value</option><option value="source">Use other value</option></NativeSelect></> : <p className="contact-merge-kept">{value(empty(target.data[f.key]) ? source.data[f.key] : target.data[f.key], f.type === 'user' ? (empty(target.data[f.key]) ? source : target).user_names?.[f.key] || 'Former member' : undefined)}<small>{empty(target.data[f.key]) ? 'Added from other contact' : 'Kept from remaining contact'}</small></p>}
          </div>
        })}</div>
        <p className="contact-merge-help">Marketing consent stays enabled only when both contacts already have it enabled. Merging cannot grant new consent.</p>
      </> : <>
        <div className="contact-merge-identity"><h3>{preview.data.name}</h3><p>{preview.data.email || 'No email'}{preview.data.phone ? ` · ${preview.data.phone}` : ''}</p><p>Remaining record: {target.data.name}<br />Archived record: {source.data.name}</p></div>
        <details className="contact-merge-details"><summary>Remaining details</summary><dl>{definition.fields.filter(f => !empty(preview.data[f.key])).map(f => <div key={f.key}><dt>{f.name}</dt><dd>{value(preview.data[f.key], f.type === 'user' ? (preview.data[f.key] === target.data[f.key] ? target : source).user_names?.[f.key] || 'Former member' : undefined)}</dd></div>)}</dl></details>
        <dl className="contact-merge-effects">{[[preview.effects.notes, 'Notes moved'], [preview.effects.relationships, 'Related records updated'], [preview.effects.links, 'Record links combined'], [preview.effects.financial_history, 'Financial records kept unchanged'], [preview.effects.stopped_sequences, 'Active source follow-ups stopped']].map(([count, label]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>
        <p>Marketing consent: <strong>{preview.data.consent ? 'Enabled' : 'Disabled'}</strong>. Tags: {preview.data.tags?.length ? preview.data.tags.join(', ') : 'None'}.</p>
        <p className="contact-merge-help">The other contact leaves active lists. Its original details and merge history are retained. Existing contact links open the remaining record. Issued financial documents and payment history keep their original details; draft links can change.</p>
        <p className="contact-merge-help">Queued source follow-ups stop. A message or call already submitted to a provider may still finish. This merge has no restore action in the application.</p>
      </>}
    </div>
    <div className="contact-merge-footer"><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>{preview && <Button variant="outline" disabled={busy} onClick={() => { setPreview(null); setError(''); setStale(false) }}>Edit choices</Button>}{preview && error && <Button variant="outline" disabled={busy} onClick={() => void review()}>Review again</Button>}<Button disabled={busy || !!preview && stale} onClick={() => void (preview ? merge() : review())}>{busy ? preview ? 'Merging...' : 'Reviewing...' : preview ? 'Confirm merge' : 'Review merge'}</Button></div>
  </DialogContent></Dialog>
}
