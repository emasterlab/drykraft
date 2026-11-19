import { useEffect, useState } from 'react'
import { AuthLayout } from '@/components/Auth'
import { Button } from '@/components/ui/button'
import { Input, PasswordField } from '@/components/ui/input'
import { LoadingPage } from '@/components/common'
import { send, workspaceRoles } from '@/lib/api'

type Invitation = { email: string; role: string; expires_at: string; accepted: boolean; workspace: { name: string; slug: string } }
export function InvitationPage() {
  const params=new URLSearchParams(window.location.search)
  const endpoint=params.get('reseller')==='1'?'/auth/reseller-invitations':params.get('platform')==='1'?'/auth/platform-invitations':'/auth/invitations'
  const [token] = useState(() => window.location.hash.slice(1)), [invite, setInvite] = useState<Invitation | null>(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [mode, setMode] = useState<'login' | 'signup'>('login'), [retry, setRetry] = useState(0)
  const [mfa,setMfa]=useState(false)
  useEffect(() => {
    let active = true; setLoading(true); setError('')
    send<Invitation>(endpoint+'/preview', { token }).then(i => { if (active) setInvite(i) }).catch(e => { if (active) setError(e.message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [token, retry, endpoint])
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError('')
    try { await send(endpoint+'/accept', { ...Object.fromEntries(new FormData(e.currentTarget)), token, mode }); window.location.assign('/crm/overview') }
    catch (e) { const message=(e as Error).message;setError(message);if(/authenticator|recovery code/.test(message))setMfa(true) } finally { setBusy(false) }
  }
  return <AuthLayout>
    {loading ? <LoadingPage /> : !invite ? <><h1>Invitation unavailable</h1><p>Ask your workspace administrator for a new invitation link.</p>{error && <p className="form-error" role="alert">{error}</p>}<Button variant="outline" onClick={() => setRetry(v => v + 1)}>Try again</Button><p className="auth-switch"><a href="/login">Return to sign in</a></p></> : invite.accepted ? <><h1>Invitation already used</h1><p>This invitation has been accepted. Sign in if you still have access to {invite.workspace.name}, or ask an administrator for a new link.</p><Button className="w-full" asChild><a href="/login">Sign in</a></Button></> : <>
      <h1>Join {invite.workspace.name}</h1><p>{invite.role==='owner'?'Accept ownership to manage this workspace, its members, settings and subscription.':'Your invitation gives you '+workspaceRoles[invite.role as keyof typeof workspaceRoles]?.name.toLowerCase()+' access. '+workspaceRoles[invite.role as keyof typeof workspaceRoles]?.description}</p>
      <form onSubmit={submit}><fieldset disabled={busy}>
        <label>Email address<Input value={invite.email} type="email" readOnly autoComplete="email" /><small>This invitation is for this email address.</small></label>
        {mode === 'signup' && <label>Your name<Input name="name" autoComplete="name" required minLength={2} maxLength={100} placeholder="Your full name" /></label>}
        <PasswordField label="Password" name="password"  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={10} maxLength={128} placeholder={mode === 'signup' ? 'At least 10 characters' : 'Your existing DryKraft password'} />
        {mfa&&<label>Authenticator or recovery code<Input name="code" autoComplete="one-time-code" required maxLength={23} autoFocus /><small>Use a new authenticator code or an unused recovery code for your existing account.</small></label>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">{busy ? 'Joining...' : mode === 'signup' ? 'Create account and join' : 'Sign in and join'}</Button>
      </fieldset></form>
      <p className="auth-switch">{mode === 'login' ? 'New to DryKraft?' : 'Already have an account?'} <button disabled={busy} onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError('') }}>{mode === 'login' ? 'Create an account' : 'Sign in'}</button></p>
      <small className="muted">Link expires {new Date(invite.expires_at).toLocaleDateString()}.</small>
    </>}
  </AuthLayout>
}
