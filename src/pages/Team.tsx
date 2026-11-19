import { useEffect, useState } from 'react'
import { Copy, LockKeyhole, UserPlus, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { PageHeading, LoadingPage, EmptyState, ErrorState, NativeSelect } from '@/components/common'
import { useWorkspace } from '@/context'
import { api, send, initials, workspaceRoles, ApiError } from '@/lib/api'

type Member = { id: string; name: string; email: string; role: string; version: number }
type Invite = { id: string; email: string; role: string; expires_at: string; active: boolean }
type Page<T> = { items: T[]; total: number; next_cursor: string | null }
const empty = { items: [], total: 0, next_cursor: null }
export function TeamPage() {
  const { session, notify } = useWorkspace(), admin = ['owner', 'admin'].includes(session.role)
  const [members, setMembers] = useState<Page<Member>>(empty), [invites, setInvites] = useState<Page<Invite>>(empty)
  const [memberPages, setMemberPages] = useState<string[]>([]), [invitePages, setInvitePages] = useState<string[]>([]), [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [email, setEmail] = useState(''), [role, setRole] = useState('member'), [link, setLink] = useState(''), [linkEmail, setLinkEmail] = useState('')
  const [target, setTarget] = useState<Member | null>(null), [action, setAction] = useState<'role' | 'remove'>('role'), [newRole, setNewRole] = useState('member'), [dialogError, setDialogError] = useState('')
  const [stale, setStale] = useState(false)
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('')
    Promise.all([api<Page<Member>>(`/settings/members${memberPages.length ? `?cursor=${encodeURIComponent(memberPages.at(-1)!)}` : ''}`, { signal: controller.signal }), admin ? api<Page<Invite>>(`/settings/invitations${invitePages.length ? `?cursor=${invitePages.at(-1)}` : ''}`, { signal: controller.signal }) : Promise.resolve(empty)])
      .then(([m, i]) => { if (!controller.signal.aborted) { setMembers(m); setInvites(i) } })
      .catch(e => { if (!controller.signal.aborted) setError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [memberPages, invitePages, admin, revision])
  const roles = Object.entries(workspaceRoles).filter(([key]) => key !== 'admin' || session.role === 'owner')
  function refresh() { setMemberPages([]); setInvitePages([]); setRevision(v => v + 1) }
  function choose(m: Member, operation: 'role' | 'remove') { setTarget(m); setAction(operation); setNewRole(m.role); setDialogError(''); setStale(false) }
  async function invite(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(''); setLink('')
    try {
      const result = await send<Invite & { token: string }>('/settings/invitations', { email, role })
      const origin = session.domain === 'localhost' ? window.location.origin : `https://app.${session.domain}`
      setLink(`${origin}/invite#${result.token}`); setLinkEmail(result.email); refresh(); notify('Invitation link created. Share it with your teammate.')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function cancelInvite(id: string) {
    setBusy(true); setError('')
    try { await api(`/settings/invitations/${id}`, { method: 'DELETE' }); setLink(''); refresh(); notify('Invitation cancelled') }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function changeMember() {
    if (!target || stale) return; setBusy(true); setDialogError('')
    try {
      if (action === 'role') await send(`/settings/members/${target.id}`, { role: newRole, version: target.version }, 'PUT')
      else await api(`/settings/members/${target.id}?version=${target.version}`, { method: 'DELETE' })
      setTarget(null); refresh(); notify(action === 'role' ? 'Workspace role updated' : 'Workspace access removed')
    } catch (e) { setDialogError((e as Error).message); if (e instanceof ApiError && [404, 409].includes(e.status)) setStale(true) } finally { setBusy(false) }
  }
  return <>
    <PageHeading title="Your team" description="Invite your teammates and give them the access they need." />
    {error && <ErrorState message={error} retry={refresh} />}
    {admin && <section className="settings-section team-invitation">
      <div className="settings-section-heading"><UserPlus size={20} /><div><h2>Invite a teammate</h2><p>Create a link for one email address. It expires in 7 days.</p></div></div>
      <form onSubmit={invite}><fieldset disabled={busy} className="team-invite-form">
        <label>Email address<Input id="team-invite-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="teammate@company.com" required maxLength={200} autoComplete="off" /></label>
        <label>Workspace role<NativeSelect value={role} onChange={e => setRole(e.target.value)}>{roles.map(([key, info]) => <option key={key} value={key}>{info.name}</option>)}</NativeSelect></label>
        <Button type="submit">{busy ? 'Working...' : 'Create invite link'}</Button>
      </fieldset></form>
      <p className="settings-note">{workspaceRoles[role as keyof typeof workspaceRoles]?.description} Creating a new link for a pending invite replaces its previous link. No email is sent automatically.</p>
      {link && <div className="team-invite-link"><label>Invitation for {linkEmail}<Input value={link} readOnly onFocus={e => e.currentTarget.select()} /></label><Button variant="outline" disabled={busy} onClick={async () => { try { await navigator.clipboard.writeText(link); notify('Invitation link copied') } catch { setError('Select the invitation link and copy it to share it.') } }}><Copy size={15} />Copy link</Button></div>}
    </section>}
    {loading ? <LoadingPage /> : <>
      <section className="records-panel team-panel"><div className="panel-heading"><div><h2>Members</h2><p>{members.total} {members.total === 1 ? 'person' : 'people'} in this workspace</p></div></div>
        <div className="table-scroll"><table className="data-table"><thead><tr><th>Member</th><th>Email address</th><th>Workspace role</th>{admin && <th>Access</th>}</tr></thead><tbody>{members.items.map(m => {
          const editable = admin && m.role !== 'owner' && (session.role === 'owner' || m.role !== 'admin')
          return <tr key={m.id}><td><span className="record-name-cell"><span className="record-avatar">{initials(m.name)}</span><strong>{m.name}</strong>{m.id === session.user.id && <span className="muted">(you)</span>}</span></td><td>{m.email}</td><td><span className="role-pill">{workspaceRoles[m.role as keyof typeof workspaceRoles]?.name || 'Owner'}</span></td>{admin && <td>{editable ? <div className="team-row-actions"><Button variant="ghost" size="sm" onClick={() => choose(m, 'role')} disabled={busy}>Change role</Button><Button variant="ghost" size="sm" onClick={() => choose(m, 'remove')} disabled={busy}>Remove access</Button></div> : <span className="muted">{m.role === 'owner' ? 'Workspace owner' : 'Owner manages access'}</span>}</td>}</tr>
        })}</tbody></table></div><TeamPager page={members} cursors={memberPages} setCursors={setMemberPages} />
      </section>
      {admin && <section className="records-panel team-panel"><div className="panel-heading"><div><h2>Pending invitations</h2><p>Share a new link or cancel access before someone joins.</p></div></div>{invites.items.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Email address</th><th>Role</th><th>Expires</th><th>Invitation</th></tr></thead><tbody>{invites.items.map(i => <tr key={i.id}><td>{i.email}</td><td>{workspaceRoles[i.role as keyof typeof workspaceRoles]?.name}</td><td>{i.active ? new Date(i.expires_at).toLocaleDateString() : 'Expired'}</td><td><div className="team-row-actions"><Button variant="ghost" size="sm" disabled={busy || (i.role === 'admin' && session.role !== 'owner')} onClick={() => { setEmail(i.email); setRole(i.role); setLink(''); document.getElementById('team-invite-email')?.focus() }}>New link</Button><Button variant="ghost" size="sm" disabled={busy || (i.role === 'admin' && session.role !== 'owner')} onClick={() => void cancelInvite(i.id)}>Cancel invite</Button></div></td></tr>)}</tbody></table></div> : <EmptyState title="No pending invitations" description="Create a link above when your next teammate is ready to join." />}<TeamPager page={invites} cursors={invitePages} setCursors={setInvitePages} /></section>}
    </>}
    <p className="settings-note"><LockKeyhole size={15} />Only the owner can grant administrator access. The owner’s access is protected.</p>
    <Dialog open={!!target} onOpenChange={open => { if (!open && !busy) setTarget(null) }}><DialogContent>
      <DialogTitle>{action === 'role' ? `Change ${target?.name}’s role` : `Remove ${target?.name}’s access?`}</DialogTitle>
      <DialogDescription>{action === 'role' ? `Choose what ${target?.email} can do in this workspace.` : 'They will lose access immediately. Their CRM records and activity stay in the workspace.'}</DialogDescription>
      {action === 'role' && <label className="stack-form">New workspace role<NativeSelect value={newRole} onChange={e => setNewRole(e.target.value)} disabled={busy || stale}>{roles.map(([key, info]) => <option key={key} value={key}>{info.name}</option>)}</NativeSelect><small>{workspaceRoles[newRole as keyof typeof workspaceRoles]?.description}</small></label>}
      {dialogError && <p className="form-error" role="alert">{dialogError}</p>}
      <div className="dialog-actions"><Button variant="outline" disabled={busy} onClick={() => setTarget(null)}>Cancel</Button>{stale ? <Button onClick={() => { setTarget(null); refresh() }}>Refresh team</Button> : <Button variant={action === 'remove' ? 'destructive' : 'default'} disabled={busy || (action === 'role' && newRole === target?.role)} onClick={() => void changeMember()}>{busy ? 'Working...' : action === 'role' ? 'Save role' : 'Remove access'}</Button>}</div>
    </DialogContent></Dialog>
  </>
}
function TeamPager({ page, cursors, setCursors }: { page: Page<unknown>; cursors: string[]; setCursors: React.Dispatch<React.SetStateAction<string[]>> }) {
  return <div className="table-footer"><span>{page.total ? `${cursors.length * 25 + 1}–${Math.min(cursors.length * 25 + page.items.length, page.total)} of ${page.total}` : '0 invitations'}</span><div><Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={!cursors.length} onClick={() => setCursors(v => v.slice(0, -1))}><ChevronLeft size={15} /></Button><span>Page {cursors.length + 1}</span><Button variant="outline" size="icon-sm" aria-label="Next page" disabled={!page.next_cursor} onClick={() => setCursors(v => [...v, page.next_cursor!])}><ChevronRight size={15} /></Button></div></div>
}
