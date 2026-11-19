import { useCallback, useEffect, useRef, useState } from 'react'
import { Monitor, LockKeyhole, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, PasswordField } from '@/components/ui/input'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { PageHeading, LoadingPage, ErrorState } from '@/components/common'
import { useWorkspace } from '@/context'
import { api, send, ApiError } from '@/lib/api'
import {AccountMfa,type MfaState} from '@/components/AccountMfa'

type DeviceSession = { id: string; device: string; created_at: string | null; last_seen_at: string | null; expires_at: string }
type Security = { current: DeviceSession; others: { items: DeviceSession[]; total: number; next_cursor: string | null }; password_changed_at: string | null; shared_demo: boolean;mfa:MfaState; history: { id: string; action: string; count: number; created_at: string }[] }
type EndTarget = { kind: 'all' } | { kind: 'session'; session: DeviceSession }
const time = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function AccountSecurityPage() {
  const { session, reload, notify } = useWorkspace()
  const [data, setData] = useState<Security | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [busy, setBusy] = useState(false), [passwordError, setPasswordError] = useState('')
  const [target, setTarget] = useState<EndTarget | null>(null), [endError, setEndError] = useState(''), [endUnavailable, setEndUnavailable] = useState(false), [ending, setEnding] = useState(false), [paging, setPaging] = useState(false), [focusRefresh, setFocusRefresh] = useState(false)
  const refresh = useRef<HTMLButtonElement>(null), endFeedback = useRef<HTMLParagraphElement>(null)
  const load = useCallback(async () => {
    setLoading(true); setError(''); setData(null)
    try { setData(await api<Security>('/account/security')) }
    catch (e) { if (e instanceof ApiError && e.status === 401) await reload(); else setError((e as Error).message) }
    finally { setLoading(false) }
  }, [reload])
  useEffect(() => { void load() }, [load])
  useEffect(() => { if (focusRefresh && !loading) { refresh.current?.focus(); setFocusRefresh(false) } }, [focusRefresh, loading])
  useEffect(() => { if (endError) endFeedback.current?.focus() }, [endError])
  function confirmEnd(value: EndTarget) { setEndError(''); setEndUnavailable(false); setTarget(value) }
  async function endSessions() {
    if (!target) return
    setEnding(true); setEndError('')
    try {
      const result = await send<{ current?: boolean; count?: number }>(target.kind === 'all' ? '/account/sessions' : `/account/sessions/${target.session.id}`, undefined, 'DELETE')
      setTarget(null)
      if (result.current) { await reload(); return }
      await load(); notify(target.kind === 'all' ? `${result.count} other session${result.count === 1 ? '' : 's'} ended` : 'Session ended'); setFocusRefresh(true)
    } catch (e) { if (e instanceof ApiError && e.status === 401) await reload(); else { setEndError((e as Error).message); setEndUnavailable(e instanceof ApiError && e.status === 404) } }
    finally { setEnding(false) }
  }
  async function changePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = e.currentTarget, values = new FormData(form); setBusy(true); setPasswordError('')
    try {
      await send('/account/password', Object.fromEntries(values)); form.reset(); await load(); notify('Password changed. Your other devices are signed out.')
    } catch (e) { if (e instanceof ApiError && e.status === 401) await reload(); else setPasswordError((e as Error).message) }
    finally { setBusy(false) }
  }
  async function moreSessions() {
    if (!data?.others.next_cursor) return
    setPaging(true); setError('')
    try {
      const next = await api<Security>(`/account/security?cursor=${data.others.next_cursor}`)
      setData({ ...next, others: { ...next.others, items: [...data.others.items, ...next.others.items.filter(item => !data.others.items.some(old => old.id === item.id))] } })
    } catch (e) { if (e instanceof ApiError && e.status === 401) await reload(); else setError((e as Error).message) }
    finally { setPaging(false) }
  }
  function deviceRow(item: DeviceSession, current = false) {
    return <li className="security-session" key={item.id}><Monitor size={19} aria-hidden="true" /><div><div className="security-device"><strong>{item.device}</strong>{current && <span className="security-current">This device</span>}</div><p>{item.last_seen_at ? `Last active ${time(item.last_seen_at)}` : 'Activity time unavailable'}</p><p>{item.created_at ? `Signed in ${time(item.created_at)}` : 'Sign-in time unavailable'}</p><p>Expires {time(item.expires_at)}</p></div><Button variant="outline" size="sm" disabled={busy || paging} aria-label={current ? 'Sign out this device' : `End ${item.device} session from ${item.created_at ? time(item.created_at) : 'an earlier sign-in'}`} onClick={() => confirmEnd({ kind: 'session', session: item })}>{current ? 'Sign out' : 'End session'}</Button></li>
  }
  return <>
    <PageHeading title="Account security" description="Manage your password and sign-ins across all your DryKraft workspaces."><Button variant="outline" asChild><a href="#account-mfa">Two-step verification</a></Button><Button variant="outline" asChild><a href="#account-password">Change password</a></Button><Button ref={refresh} variant="ghost" aria-label="Refresh account security" disabled={loading || paging || busy || ending} onClick={() => void load()}><RefreshCw size={16} />Refresh</Button></PageHeading>
    <p className="security-account">Signed in as <strong>{session.user.email}</strong></p>
    {error && <ErrorState message={error} retry={() => void load()} />}
    {loading ? <LoadingPage /> : data && <div className="security-layout">
      <section className="security-section" aria-labelledby="security-sessions"><div className="security-section-heading"><h2 id="security-sessions">Signed-in devices</h2><p>Browser tabs share a session. Device names come from the browser and may be approximate.</p></div>
        <ul className="security-sessions">{deviceRow(data.current, true)}</ul>
        <div className="security-other-heading"><h3>Other sessions <span>{data.others.total}</span></h3>{data.others.total > 0 && <Button variant="outline" size="sm" disabled={busy || paging} onClick={() => confirmEnd({ kind: 'all' })}>End all other sessions</Button>}</div>
        {data.others.items.length ? <ul className="security-sessions">{data.others.items.map(item => deviceRow(item))}</ul> : <p className="security-empty">You’re signed in only on this device.</p>}
        {data.others.next_cursor && <Button className="security-more" variant="outline" disabled={paging || busy} onClick={() => void moreSessions()}>{paging ? 'Loading...' : 'Show more sessions'}</Button>}
        <p className="security-time-note">Times use this browser’s local time. Activity updates about every five minutes. Sessions expire seven days after sign-in.</p>
      </section>
      <section id="account-password" className="security-section security-password" aria-labelledby="security-password-title"><div className="security-section-heading"><h2 id="security-password-title">Change password</h2><p>This changes your account password for every workspace.</p></div>
        {data.shared_demo ? <p className="security-empty">Password changes are unavailable in this shared sample account. Create your own account to manage a password.</p> : <form className="stack-form" onSubmit={changePassword}><fieldset disabled={busy || paging}>
          <input type="hidden" name="username" autoComplete="username" value={session.user.email} />
          <PasswordField label="Current password" name="current_password"  autoComplete="current-password" required minLength={10} maxLength={128} />
          <PasswordField label="New password" name="new_password" aria-label="New password" aria-describedby="security-password-help"  autoComplete="new-password" required minLength={10} maxLength={128}><small id="security-password-help">Use 10 to 128 characters. A long, unique password is best.</small></PasswordField>
          <PasswordField label="Confirm new password" name="confirm_password"  autoComplete="new-password" required minLength={10} maxLength={128} />
          <p className="security-password-note"><LockKeyhole size={16} aria-hidden="true" />Your other devices will be signed out. This device will stay signed in with a new session.</p>
          {passwordError && <p className="form-error" role="alert">{passwordError}</p>}
          <Button type="submit" disabled={busy}>{busy ? 'Changing password...' : 'Update password'}</Button>
        </fieldset></form>}
        <p className="security-time-note">{data.password_changed_at ? `Password last changed ${time(data.password_changed_at)}.` : 'No password change recorded.'}</p>
      </section>
      <AccountMfa state={data.mfa} sharedDemo={data.shared_demo} onChanged={load} onExpired={reload}/>
      <section className="security-section security-history" aria-labelledby="security-history"><div className="security-section-heading"><h2 id="security-history">Recent security changes</h2><p>Your latest 20 account security changes. This history is private to your account.</p></div>{data.history.length ? <ul>{data.history.map(item => <li key={item.id}><span>{({'password.changed':'Password changed. Other sessions ended.','session.ended':'Session ended','mfa.enabled':'Two-step verification enabled','mfa.disabled':'Two-step verification turned off','mfa.recovery.regenerated':'Recovery codes replaced','mfa.recovery.used':'Recovery code used'} as Record<string,string>)[item.action] || `${item.count} other session${item.count === 1 ? '' : 's'} ended`}</span><time dateTime={item.created_at}>{time(item.created_at)}</time></li>)}</ul> : <p className="security-empty">No account security changes yet.</p>}</section>
    </div>}
    <Dialog open={!!target} onOpenChange={open => { if (!open && !ending) setTarget(null) }}><DialogContent><DialogTitle>{target?.kind === 'all' ? 'End all other sessions?' : target?.kind === 'session' && target.session.id === data?.current.id ? 'Sign out this device?' : 'End this session?'}</DialogTitle><DialogDescription>{target?.kind === 'all' ? 'Every other device will need to sign in again, across all your workspaces. This device will stay signed in.' : target?.kind === 'session' ? `${target.session.device} will need to sign in again. Ending this session applies across all your workspaces.` : ''}</DialogDescription>{endError && <p ref={endFeedback} className="form-error" role="alert" tabIndex={-1}>{endError}</p>}<div className="security-dialog-actions"><Button variant="outline" disabled={ending} onClick={() => setTarget(null)}>Cancel</Button><Button disabled={ending} onClick={() => { if (endUnavailable) { setTarget(null); setFocusRefresh(true); void load() } else void endSessions() }}>{ending ? 'Ending...' : endUnavailable ? 'Refresh list' : target?.kind === 'all' ? 'End other sessions' : target?.kind === 'session' && target.session.id === data?.current.id ? 'Sign out' : 'End session'}</Button></div></DialogContent></Dialog>
  </>
}
