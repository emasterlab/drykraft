import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Flame, Pause, Play, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorState, LoadingPage, NativeSelect, Status } from '@/components/common'
import { useWorkspace } from '@/context'
import { api, send } from '@/lib/api'

type Plan = { startDaily: number; dailyIncrease: number; targetDaily: number }
type Overview = {
 status: 'disabled' | 'active' | 'paused' | 'completed'; day?: number; dailyLimit: number; hourlyLimit: number
 connectionDailyLimit: number; connectionHourlyLimit: number; sendingEnabled: boolean; nextIncreaseAt?: string | null
 remainingDaily: number; remainingHourly: number; usage: { daily: number; hourly: number; accepted: number }; plan: Plan | null
}
type Mailbox = { id: string; name: string; channel: string }

export function EmailWarmup({ connectionId }: { connectionId?: string }) {
 const { session, notify } = useWorkspace(), admin = ['owner', 'admin'].includes(session.role)
 const [mailboxes, setMailboxes] = useState<Mailbox[]>([]), [selected, setSelected] = useState('')
 const [overview, setOverview] = useState<Overview>(), [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(false)
 const [settings, setSettings] = useState<Plan>({ startDaily: 5, dailyIncrease: 5, targetDaily: 100 }), [restart, setRestart] = useState(false)
 const id = connectionId || selected
 const loadMailboxes = useCallback(async (signal?: AbortSignal) => {
  const items = await api<Mailbox[]>('/outreach/connections', { signal })
  if (signal?.aborted) return
  const emails = items.filter(item => item.channel === 'email')
  setMailboxes(emails); setSelected(emails[0]?.id || ''); setError('')
 }, [])
 useEffect(() => {
  if (connectionId) return
  const controller = new AbortController()
  loadMailboxes(controller.signal).catch(e => { if (!controller.signal.aborted) setError(e.message) })
   .finally(() => { if (!controller.signal.aborted) setLoading(false) })
  return () => { controller.abort() }
 }, [connectionId, loadMailboxes])
 const load = useCallback(async (signal?: AbortSignal) => {
  const data = await api<Overview>(`/outreach/connections/${id}/warmup`, { signal })
  if (!signal?.aborted) { setOverview(data); setError('') }
  return data
 }, [id])
 useEffect(() => {
  if (!id) return
  const controller = new AbortController()
  setLoading(true); setOverview(undefined); setError(''); setRestart(false)
  load(controller.signal).then(data => {
   if (controller.signal.aborted) return
   const { startDaily, dailyIncrease, targetDaily } = data.plan || { startDaily: Math.min(5, data.connectionDailyLimit), dailyIncrease: 5, targetDaily: data.connectionDailyLimit }
   setSettings({ startDaily, dailyIncrease, targetDaily })
  })
   .catch(e => { if (!controller.signal.aborted) setError(e.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
  const timer = window.setInterval(() => { void load(controller.signal).catch(e => { if (!controller.signal.aborted) setError(e.message) }) }, 30000)
  return () => { controller.abort(); window.clearInterval(timer) }
 }, [id, load])
 async function action(fn: () => Promise<Overview>) {
  setBusy(true); setError('')
  try { setOverview(await fn()); setRestart(false); notify('Email warmup updated') }
  catch (e) { setError((e as Error).message) } finally { setBusy(false) }
 }
 function status(value: 'active' | 'paused' | 'disabled') { void action(() => send(`/outreach/connections/${id}/warmup/status`, { status: value })) }
 return <section className="settings-section outreach-editor stack-form email-warmup" aria-label="Email warmup">
  <div className="outreach-section-heading"><h2><Flame size={18} /> Email warmup</h2>{overview && <Status value={overview.status === 'disabled' ? 'Not started' : overview.status} />}</div>
  <p className="outreach-footnote">Gradually increase this mailbox’s sending allowance across email campaigns and sequences. Launch a reviewed campaign to send messages; excess messages stay queued.</p>
  {!connectionId && mailboxes.length > 0 && <label>Email account<NativeSelect value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}>{mailboxes.map(mailbox => <option key={mailbox.id} value={mailbox.id}>{mailbox.name}</option>)}</NativeSelect></label>}
  {error && <ErrorState message={error} retry={() => { void (id ? load() : loadMailboxes()).catch(e => setError(e.message)) }} />}
  {loading ? <LoadingPage /> : !id ? <p>Connect an email account to start warmup. <Link className="text-link" to="/outreach/connections">Manage connections</Link></p> : overview && <>
   <div className="email-warmup-metrics" aria-live="polite">
    <div><strong>{overview.dailyLimit}</strong><span>Current daily allowance</span></div>
    <div><strong>{overview.usage.daily} / {overview.dailyLimit}</strong><span>Reserved in the last 24 hours</span></div>
    <div><strong>{overview.remainingDaily}</strong><span>Daily allowance remaining</span></div>
    <div><strong>{overview.usage.accepted}</strong><span>Accepted in the last 24 hours</span></div>
   </div>
   <p className="outreach-footnote">Hourly allowance: {overview.hourlyLimit}, with {overview.remainingHourly} remaining. {overview.day && `Warmup day ${overview.day}. `}{overview.nextIncreaseAt && `Next increase: ${new Date(overview.nextIncreaseAt).toLocaleString()}. `}Connection cap: {overview.connectionDailyLimit} daily / {overview.connectionHourlyLimit} hourly.</p>
   {overview.status === 'paused' && <p className="outreach-notice">The ramp is paused at its current allowance. Campaigns can continue sending within that allowance.</p>}
   {!overview.sendingEnabled && <p className="outreach-notice">Verify and enable this email connection before starting or resuming warmup. <Link className="text-link" to={`/outreach/connections/${id}`}>Manage account</Link></p>}
   {admin ? <form className="stack-form" onSubmit={e => { e.preventDefault(); void action(() => send(`/outreach/connections/${id}/warmup`, { ...settings, restart }, 'PUT')) }}>
    <fieldset className="stack-form" disabled={busy}>
     <div className="outreach-form-grid">
      <label>Starting daily allowance<Input type="number" required min={1} max={overview.connectionDailyLimit} value={settings.startDaily} onChange={e => setSettings(v => ({ ...v, startDaily: Number(e.target.value) }))} /></label>
      <label>Increase every 24 hours<Input type="number" required min={1} max={1000} value={settings.dailyIncrease} onChange={e => setSettings(v => ({ ...v, dailyIncrease: Number(e.target.value) }))} /></label>
      <label>Target daily allowance<Input type="number" required min={settings.startDaily || 1} max={overview.connectionDailyLimit} value={settings.targetDaily} onChange={e => setSettings(v => ({ ...v, targetDaily: Number(e.target.value) }))} /></label>
     </div>
     {overview.status !== 'disabled' && <label className="outreach-check"><input type="checkbox" checked={restart} onChange={e => setRestart(e.target.checked)} />Restart from day 1 when saving</label>}
     <div className="outreach-actions">
      <Button type="submit" disabled={!overview.sendingEnabled}>{busy ? 'Updating...' : overview.status === 'disabled' ? 'Start warmup' : restart ? 'Restart warmup' : 'Save warmup settings'}</Button>
      {overview.status === 'active' && <Button type="button" variant="outline" onClick={() => status('paused')}><Pause size={15} />Pause ramp</Button>}
      {overview.status === 'paused' && <Button type="button" variant="outline" disabled={!overview.sendingEnabled} onClick={() => status('active')}><Play size={15} />Resume ramp</Button>}
      {overview.status !== 'disabled' && <Button type="button" variant="outline" onClick={() => status('disabled')}>Turn off warmup</Button>}
     </div>
    </fieldset>
   </form> : <p className="outreach-footnote">A workspace owner or administrator can manage warmup.</p>}
   <div className="outreach-actions"><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { void load().catch(e => setError(e.message)) }}><RefreshCw size={14} />Refresh usage</Button></div>
   <p className="outreach-footnote">Allowances increase after each full 24 hours of active warmup. Sending reservations count even when the provider outcome is unknown. Turning off warmup restores the connection’s configured limits. Consent, suppressions and campaign review still apply. Provider acceptance does not confirm inbox placement.</p>
  </>}
 </section>
}
