import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Plus, RefreshCw, Copy, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, PasswordField } from '@/components/ui/input'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { PageHeading, LoadingPage, ErrorState, NativeSelect } from '@/components/common'
import { useWorkspace } from '@/context'
import { api, send, ApiError, type ObjectDefinition } from '@/lib/api'

type Permissions = Record<string, string[]>
type Account = { id: string; name: string; permissions: Permissions; disabled: boolean; version: number }
type Key = { id: string; name: string; prefix: string; permissions: Permissions; expires_at: string; revoked_at: string | null; version: number }
type AccountPage = { accounts: Account[]; next_cursor: string | null }
type KeyPage = { account: Account; keys: Key[]; next_cursor: string | null }
type RequestPage = { items: { id: string; account_name: string; key_name: string; operation: string; status: number; created_at: string }[]; next_cursor: string | null }
type WorkflowListAccount = { id: string; workflow_name: string; workflow_version: number; published: boolean; disabled: boolean; object_count: number }
type WorkflowList = { accounts: WorkflowListAccount[]; next_cursor: string | null }
type WorkflowAccount = Account & { workflow_id: string; workflow_name: string; workflow_version: number; published: boolean; campaign_id: string | null; ai_connection_id: string | null; workflow_scope: { permissions: Permissions; kinds: string[]; versions: string[] } }
type WorkflowDetail = { account: WorkflowAccount; resources: Record<'credentials' | 'calendars' | 'connections', { id: string; name: string }[]> }
type KeyAction = { kind: 'create' } | { kind: 'rotate' | 'revoke'; key: Key }
const actions = { read: 'Read', create: 'Create', update: 'Update', delete: 'Delete', note: 'Add notes' }
const objectActions = (p: Permissions, key: string) => Object.hasOwn(p, key) ? p[key] : []
const normalized = (p: Permissions) => JSON.stringify(Object.entries(p).sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, [...values].sort()]))
const date = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function PermissionPicker({ value, onChange, objects, ceiling }: { value: Permissions; onChange: (value: Permissions) => void; objects: ObjectDefinition[]; ceiling?: Permissions }) {
  function toggle(key: string, action: string) {
    const next = { ...value }, current = objectActions(next, key)
    if (action === 'read' && current.includes('read')) delete next[key]
    else next[key] = current.includes(action) ? current.filter(a => a !== action) : [...new Set([...current, action])].sort()
    onChange(next)
  }
  return <div className="developer-permissions">{objects.filter(o => !ceiling || Object.hasOwn(ceiling, o.key)).map(o => <fieldset key={o.key} className="developer-permission-row"><legend>{o.name}</legend><div>{Object.entries(actions).filter(([key]) => ceiling ? ceiling[o.key]?.includes(key) : !['invoices', 'expenses'].includes(o.key) || ['read', 'note'].includes(key)).map(([key, label]) => <label key={key}><input type="checkbox" aria-label={`${o.name}: ${label}`} checked={objectActions(value, o.key).includes(key)} disabled={key !== 'read' && !objectActions(value, o.key).includes('read')} onChange={() => toggle(o.key, key)} />{label}</label>)}</div></fieldset>)}</div>
}
function PermissionSummary({ value, objects }: { value: Permissions; objects: ObjectDefinition[] }) {
  return <ul className="developer-permission-summary">{Object.entries(value).map(([key, permissions]) => <li key={key}><strong>{objects.find(o => o.key === key)?.name || key}</strong><span>{permissions.map(a => actions[a as keyof typeof actions]).join(', ')}</span></li>)}</ul>
}

export function DeveloperAccessPage() {
  const { session } = useWorkspace(), admin = ['owner', 'admin'].includes(session.role)
  const [data, setData] = useState<AccountPage | null>(null), [history, setHistory] = useState<RequestPage | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [paging, setPaging] = useState(false)
  const load = useCallback(async () => {
    if (!admin) { setLoading(false); return }
    setLoading(true); setError('')
    try { const [accounts, requests] = await Promise.all([api<AccountPage>('/developer/accounts'), api<RequestPage>('/developer/requests')]); setData(accounts); setHistory(requests) } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }, [admin])
  useEffect(() => { void load() }, [load])
  async function more(kind: 'accounts' | 'requests') {
    const cursor = kind === 'accounts' ? data?.next_cursor : history?.next_cursor
    if (!cursor) return; setPaging(true); setError('')
    try {
      if (kind === 'accounts') { const next = await api<AccountPage>(`/developer/accounts?cursor=${cursor}`); setData(old => ({ ...next, accounts: [...(old?.accounts || []), ...next.accounts] })) }
      else { const next = await api<RequestPage>(`/developer/requests?cursor=${cursor}`); setHistory(old => ({ ...next, items: [...(old?.items || []), ...next.items] })) }
    } catch (e) { setError((e as Error).message) } finally { setPaging(false) }
  }
  return <><PageHeading title="Developer access" description="Review workspace access for integrations and published workflows.">{admin && <><Button variant="ghost" disabled={loading || paging} onClick={() => void load()}><RefreshCw size={16} />Refresh</Button><Button asChild><Link to="/settings/developer/new"><Plus size={16} />New service account</Link></Button></>}</PageHeading>{!admin ? <p>Only workspace owners and administrators can manage integration access.</p> : <div className="developer-page">{error && <ErrorState message={error} retry={() => void load()} />}{loading ? <LoadingPage /> : data && <><p className="developer-help">Service accounts use expiring API keys instead of a teammate’s sign-in. A key can access every field in its approved objects. It cannot sign in to the app, manage billing or configure providers. <a href="/docs/product/developer-access" target="_blank" rel="noreferrer">Read the access guide</a>.</p><section aria-labelledby="developer-accounts"><h2 id="developer-accounts">Service accounts</h2>{data.accounts.length ? <div className="outreach-list">{data.accounts.map(item => <Link key={item.id} className="outreach-list-row" to={`/settings/developer/${item.id}`}><div><h3>{item.name}</h3><p>{Object.keys(item.permissions).length} approved object{Object.keys(item.permissions).length === 1 ? '' : 's'}</p></div><span className="developer-status">{item.disabled ? 'Disabled' : 'Enabled'}</span><span className="outreach-open">Manage access</span></Link>)}</div> : <p className="developer-empty">No integrations have access yet. Create a service account, choose its objects, then approve a named key.</p>}{data.next_cursor && <Button variant="outline" disabled={paging} onClick={() => void more('accounts')}>{paging ? 'Loading...' : 'Show more accounts'}</Button>}</section><WorkflowAccountsSection /><section className="developer-history" aria-labelledby="developer-history"><h2 id="developer-history">API request history</h2><p className="developer-help">Normalized operations and statuses. Credentials and customer payloads stay out of this history. Valid authenticated attempts count toward API usage.</p>{history?.items.length ? <ul className="developer-requests">{history.items.map(item => <li key={item.id}><div><strong>{item.account_name}</strong><small>{item.key_name}</small><code>{item.operation}</code></div><div><span className="developer-status">HTTP {item.status}</span><time dateTime={item.created_at}>{date(item.created_at)}</time></div></li>)}</ul> : <p className="developer-empty">No authenticated API requests recorded yet.</p>}{history?.next_cursor && <Button variant="outline" disabled={paging} onClick={() => void more('requests')}>{paging ? 'Loading...' : 'Show more requests'}</Button>}<p className="developer-help">Request history is recorded after each response. A process interruption can leave a missing history row; usage is metered before dispatch.</p></section></>}</div>}</>
}

export function DeveloperAccountPage() {
  const [query] = useSearchParams()
  return query.get('type') === 'workflow' ? <WorkflowAccountPage /> : <IntegrationAccountPage />
}

function WorkflowAccountsSection() {
  const [data, setData] = useState<WorkflowList | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const load = useCallback(async (cursor?: string) => {
    setBusy(true); setError('')
    try {
      const next = await api<WorkflowList>(`/developer/workflows${cursor ? `?cursor=${cursor}` : ''}`)
      setData(old => ({ ...next, accounts: cursor ? [...(old?.accounts || []), ...next.accounts] : next.accounts }))
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  return <section className="developer-history" aria-labelledby="workflow-accounts-title">
    <div className="outreach-section-heading"><h2 id="workflow-accounts-title">Workflow accounts</h2><Button variant="ghost" disabled={busy} onClick={() => void load()}><RefreshCw size={16} />Refresh workflows</Button></div>
    <p className="developer-help">Every published version has its own identity, limited to its reviewed steps. Review access here, reduce native object actions or disable a version.</p>
    {error && <ErrorState message={error} retry={() => void load()} />}
    {!data && busy ? <LoadingPage /> : data && <>
      {data.accounts.length ? <div className="outreach-list">{data.accounts.map(item => <Link key={item.id} className="outreach-list-row" to={`/settings/developer/${item.id}?type=workflow`}>
        <div><h3>{item.workflow_name}</h3><p>Version {item.workflow_version} - {item.published ? 'Current' : 'Historical'} - {item.object_count} approved object{item.object_count === 1 ? '' : 's'}</p></div>
        <span className="developer-status">{item.disabled ? 'Disabled' : 'Enabled'}</span><span className="outreach-open">Review access</span>
      </Link>)}</div> : <p className="developer-empty">No workflow versions published yet. Publish a reviewed workflow to create its account automatically.</p>}
      {data.next_cursor && <Button variant="outline" disabled={busy} onClick={() => void load(data.next_cursor!)}>{busy ? 'Loading...' : 'Show more workflows'}</Button>}
    </>}
  </section>
}

function WorkflowAccountPage() {
  const { id } = useParams(), { session, objects, notify } = useWorkspace(), admin = ['owner', 'admin'].includes(session.role)
  const [data, setData] = useState<WorkflowDetail | null>(null), [permissions, setPermissions] = useState<Permissions>({}), [disabled, setDisabled] = useState(false), [password, setPassword] = useState('')
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false)
  const load = useCallback(async () => {
    if (!admin) { setLoading(false); return }
    setLoading(true); setError(''); setPassword('')
    try {
      const next = await api<WorkflowDetail>(`/developer/workflows/${id}`)
      setData(next); setPermissions(next.account.permissions); setDisabled(next.account.disabled); setStale(false)
    } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }, [admin, id])
  useEffect(() => { setData(null); void load() }, [load])
  const account = data?.account
  const dirty = !!account && (disabled !== account.disabled || normalized(permissions) !== normalized(account.permissions))
  const approval = !!account && (account.disabled && !disabled || Object.entries(permissions).some(([key, values]) => values.some(action => !objectActions(account.permissions, key).includes(action))))
  const permissionObjects = account ? Object.keys(account.workflow_scope.permissions).map(key => objects.find(o => o.key === key) || { key, name: `${key} (unavailable)`, singular_name: key, fields: [], built_in: false }) : []
  async function save(e: React.FormEvent) {
    e.preventDefault(); if (!account) return
    setBusy(true); setError('')
    try {
      const saved = await send<WorkflowAccount>(`/developer/workflows/${id}`, { version: account.version, permissions, disabled, ...(password ? { password } : {}) }, 'PUT')
      setData(old => old ? { ...old, account: saved } : old); setPermissions(saved.permissions); setDisabled(saved.disabled); setStale(false)
      notify(saved.disabled ? 'Workflow version disabled. Further checked effects are blocked.' : 'Workflow access saved.')
    } catch (e) { setError((e as Error).message); setStale(e instanceof ApiError && e.status === 409) } finally { setPassword(''); setBusy(false) }
  }
  return <>
    <PageHeading title="Manage workflow access" description="Control the authority of one published version.">
      <Button variant="outline" asChild><Link to="/settings/developer">All service accounts</Link></Button>
      {admin && <Button variant="ghost" disabled={loading || busy} onClick={() => void load()}><RefreshCw size={16} />Refresh saved settings</Button>}
    </PageHeading>
    {!admin ? <p>Workspace administrator access is required.</p> : loading ? <LoadingPage /> : <div className="developer-page">
      {error && <ErrorState message={error} />}
      {stale && <p className="developer-help">Your edits are retained. Refresh saved settings to discard them and review the latest access.</p>}
      {account && data && <form className="stack-form developer-account-form" onSubmit={save}><fieldset disabled={busy || stale}>
        <label>Workflow identity<Input readOnly value={account.name} /><small>{account.workflow_name} - Version {account.workflow_version} - {account.published ? 'Current published version' : 'Historical version'}</small></label>
        <section aria-labelledby="workflow-permissions-title">
          <h2 id="workflow-permissions-title">Approved objects and actions</h2>
          <p className="developer-help">The published steps set the original limits. Uncheck actions to reduce access. Read includes every field and owner in that object; field and team restrictions are not available here. Future objects are not granted automatically.</p>
          {permissionObjects.length ? <PermissionPicker value={permissions} onChange={setPermissions} objects={permissionObjects} ceiling={account.workflow_scope.permissions} /> : <p className="developer-empty">This version has no native object permissions. Its reviewed steps and saved resources still apply.</p>}
        </section>
        <label className="developer-checkbox"><input type="checkbox" checked={disabled} onChange={e => setDisabled(e.target.checked)} />Disable this workflow version<small>Blocks new runs and further checked effects, including called workflows. A request already accepted by an external provider may finish. Completed work and history remain.</small></label>
        {approval && <PasswordField label="Current password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required minLength={10} maxLength={128}><small>Required to restore actions or enable a disabled version.</small></PasswordField>}
        <div className="outreach-actions"><Button type="submit" disabled={!dirty || busy || stale}>{busy ? 'Saving...' : 'Save workflow access'}</Button></div>
        <p className="developer-help">Changes apply to this version. Publishing a new reviewed version creates fresh access; older restrictions do not carry over automatically. Workflow accounts cannot receive API keys.</p>
      </fieldset>
      <section aria-labelledby="workflow-resources-title"><h2 id="workflow-resources-title">Published resource limits</h2><p className="developer-help">Native object permissions above govern CRM and Finance actions. These saved resources retain the authority approved in the published steps. Publish a reviewed version to change them, or disable this version to block further use.</p>
        {(['credentials', 'calendars', 'connections'] as const).map(key => <div key={key}><h3>{key === 'credentials' ? 'Saved credentials' : key === 'calendars' ? 'Calendars' : 'Outreach connections'}</h3>{data.resources[key].length ? <ul className="developer-permission-summary">{data.resources[key].map(item => <li key={item.id}>{item.name}</li>)}</ul> : <p className="developer-help">None approved.</p>}</div>)}
      </section></form>}
    </div>}
  </>
}

function IntegrationAccountPage() {
  const { id = 'new' } = useParams(), navigate = useNavigate(), { session, objects, notify } = useWorkspace(), isNew = id === 'new', admin = ['owner', 'admin'].includes(session.role)
  const [operationId, setOperationId] = useState(() => crypto.randomUUID()), [data, setData] = useState<KeyPage | null>(null), [name, setName] = useState(''), [permissions, setPermissions] = useState<Permissions>({}), [disabled, setDisabled] = useState(false), [password, setPassword] = useState('')
  const [loading, setLoading] = useState(!isNew), [busy, setBusy] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false), [dialog, setDialog] = useState<KeyAction | null>(null), [paging, setPaging] = useState(false)
  const load = useCallback(async () => {
    if (isNew || !admin) { setLoading(false); return }
    setLoading(true); setError(''); setStale(false); setPassword('')
    try { const next = await api<KeyPage>(`/developer/accounts/${id}/keys`); setData(next); setName(next.account.name); setPermissions(next.account.permissions); setDisabled(next.account.disabled) } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }, [id, isNew, admin])
  useEffect(() => { if (isNew) { setOperationId(crypto.randomUUID()); setData(null); setName(''); setPermissions({}); setDisabled(false); setError(''); setStale(false) }; void load() }, [load, isNew])
  const dirty = !!data && (name !== data.account.name || disabled !== data.account.disabled || normalized(permissions) !== normalized(data.account.permissions))
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('')
    try {
      const item = await send<Account>(isNew ? '/developer/accounts' : `/developer/accounts/${id}`, { name, permissions, ...(isNew ? { id: operationId, password } : { version: data?.account.version, disabled, ...(password ? { password } : {}) }) }, isNew ? 'POST' : 'PUT')
      setPassword(''); notify(isNew ? 'Service account created. Choose a key for this integration.' : 'Account saved. Existing keys retain only their approved permissions.')
      if (isNew) navigate(`/settings/developer/${item.id}`); else await load()
    } catch (e) { setPassword(''); setError((e as Error).message); setStale(e instanceof ApiError && e.status === 409) } finally { setBusy(false) }
  }
  async function moreKeys() {
    if (!data?.next_cursor) return; setPaging(true); setError('')
    try { const next = await api<KeyPage>(`/developer/accounts/${id}/keys?cursor=${data.next_cursor}`); if (next.account.version !== data.account.version) { setStale(true); setError('This account changed. Refresh saved settings before managing keys.'); return }; setData({ ...next, keys: [...data.keys, ...next.keys] }) } catch (e) { setError((e as Error).message) } finally { setPaging(false) }
  }
  return <><PageHeading title={isNew ? 'New service account' : 'Manage integration access'} description="Approve only the records and actions this integration needs."><Button variant="outline" asChild><Link to="/settings/developer">All service accounts</Link></Button>{!isNew && admin && <Button variant="ghost" disabled={loading || busy || paging || !!dialog} onClick={() => void load()}><RefreshCw size={16} />Refresh saved settings</Button>}</PageHeading>{!admin ? <p>Workspace administrator access is required.</p> : loading ? <LoadingPage /> : <div className="developer-page">{error && <ErrorState message={error} />}{stale && <p className="developer-help">{isNew ? 'This creation reference may already exist. Open All service accounts to review it before creating another.' : 'Refresh saved settings before trying again. Refresh discards uncommitted edits.'}</p>}{(isNew || data) && <><form className="stack-form developer-account-form" onSubmit={save}><fieldset disabled={busy || paging || stale}><label>Service account name<Input value={name} onChange={e => setName(e.target.value)} required minLength={2} maxLength={100} placeholder="For example, order sync" /></label><section aria-labelledby="developer-permissions-title"><h2 id="developer-permissions-title">Approved objects and actions</h2><p className="developer-help">Read includes every field and owner in the selected object. Other actions need Read. Financial objects allow Read and Add notes only. New objects are not granted automatically.</p><PermissionPicker value={permissions} onChange={setPermissions} objects={objects} /></section>{!isNew && <label className="developer-checkbox"><input type="checkbox" checked={disabled} onChange={e => setDisabled(e.target.checked)} />Disable this service account<small>Blocks every key after in-flight work completes. Stored records and key history remain.</small></label>}<PasswordField label="Current password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required={isNew} minLength={10} maxLength={128}><small>{isNew ? 'Required to approve this new integration identity.' : 'Required only when expanding access or enabling a disabled account. Reducing access permanently narrows its existing keys.'}</small></PasswordField><div className="outreach-actions"><Button type="submit" disabled={!Object.keys(permissions).length || !isNew && !dirty}>{busy ? 'Saving...' : isNew ? 'Create service account' : 'Save account'}</Button></div></fieldset></form>{!isNew && data && <section className="developer-keys" aria-labelledby="developer-keys"><div className="outreach-section-heading"><h2 id="developer-keys">API keys</h2><Button disabled={busy || paging || dirty || stale || data.account.disabled} onClick={() => setDialog({ kind: 'create' })}><KeyRound size={16} />Create key</Button></div>{dirty && <p className="developer-help">Save or refresh account changes before managing its keys.</p>}{data.account.disabled && <p className="developer-help">This account is disabled. Enable it with password approval to issue or rotate a key.</p>}{data.keys.length ? <ul className="developer-key-list">{data.keys.map(item => { const revoked = !!item.revoked_at, expired = new Date(item.expires_at).getTime() <= Date.now(); return <li key={item.id}><div><h3>{item.name}</h3><p><code>{item.prefix}</code><span className="developer-status">{revoked ? 'Revoked' : expired ? 'Expired' : 'Active'}</span></p><small>Expires {date(item.expires_at)}</small><details><summary>Key permissions</summary><PermissionSummary value={item.permissions} objects={objects} /></details></div><div className="outreach-actions"><Button variant="outline" size="sm" aria-label={`Rotate ${item.name}`} disabled={busy || paging || dirty || stale || revoked || data.account.disabled} onClick={() => setDialog({ kind: 'rotate', key: item })}>Rotate</Button><Button variant="outline" size="sm" aria-label={`Revoke ${item.name}`} disabled={busy || paging || dirty || stale || revoked} onClick={() => setDialog({ kind: 'revoke', key: item })}>Revoke</Button></div></li> })}</ul> : <p className="developer-empty">No key has been issued. Choose a name, narrower permissions and an expiry before approving access.</p>}{data.next_cursor && <Button variant="outline" disabled={paging || busy || dirty || stale} onClick={() => void moreKeys()}>{paging ? 'Loading...' : 'Show more keys'}</Button>}<p className="developer-help">Secrets are shown only once. Rotation revokes the old key immediately; for a staged change, create a separate key first. Requests already in flight can finish.</p></section>}</>}</div>}{dialog && data && <KeyDialog key={dialog.kind + ('key' in dialog ? dialog.key.id : '')} account={data.account} action={dialog} onClose={() => { setDialog(null); void load() }} />}</>
}

function KeyDialog({ account, action, onClose }: { account: Account; action: KeyAction; onClose: () => void }) {
  const { objects, notify } = useWorkspace(), [id] = useState(() => crypto.randomUUID()), [name, setName] = useState(''), [permissions, setPermissions] = useState<Permissions>({}), [days, setDays] = useState(90), [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false), [ambiguous, setAmbiguous] = useState(false), [receipt, setReceipt] = useState<{ key: Key; secret: string | null } | null>(null)
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('')
    try {
      const base = `/developer/accounts/${account.id}/keys`
      if (action.kind === 'revoke') { await send(`${base}/${action.key.id}/revoke`, { version: action.key.version }); notify('Key revoked. Future requests with it are blocked.'); onClose(); return }
      const result = await send<{ key: Key; secret: string | null }>(action.kind === 'create' ? base : `${base}/${action.key.id}/rotate`, { id, days, password, account_version: account.version, ...(action.kind === 'create' ? { name, permissions } : { version: action.key.version }) })
      setReceipt(result); setPassword('')
    } catch (e) { setPassword(''); setError((e as Error).message); setStale(e instanceof ApiError && e.status === 409); if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) setAmbiguous(true) } finally { setBusy(false) }
  }
  async function copy() { if (!receipt?.secret) return; try { await navigator.clipboard.writeText(receipt.secret); notify('API key copied. Store it in your integration’s secret store.') } catch { setError('Copy did not work. Show the key and copy it manually.') } }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="developer-key-dialog" onInteractOutside={e => e.preventDefault()}><DialogTitle>{receipt ? receipt.secret ? 'Save your API key' : 'Key already created' : action.kind === 'create' ? 'Create a scoped API key' : action.kind === 'rotate' ? 'Rotate this key?' : 'Revoke this key?'}</DialogTitle><DialogDescription>{receipt ? 'The secret is not stored in a retrievable form. Closing this window removes it from the screen.' : action.kind === 'create' ? `For ${account.name}. Review permissions and expiry, then approve with your current password.` : action.kind === 'rotate' ? `${action.key.name}: the old key stops working when rotation completes. Update your integration with the one-time replacement.` : `${action.key.name}: future requests will be blocked. In-flight work can finish; saved records remain.`}</DialogDescription>{error && <p className="form-error" role="alert">{error}</p>}{receipt ? <div className="developer-key-receipt"><p><strong>{receipt.key.name}</strong> <code>{receipt.key.prefix}</code><br />Expires {date(receipt.key.expires_at)}</p>{receipt.secret ? <><PasswordField label="One-time API key" readOnly  value={receipt.secret} autoComplete="off" aria-label="One-time API key" spellCheck={false} /><div className="outreach-actions"><Button variant="outline" onClick={() => void copy()}><Copy size={16} />Copy key</Button></div><p>Keep it in a private secret store. Never place it in a browser bundle, URL, shared screenshot or source repository.</p></> : <p>The earlier request completed, but its one-time secret cannot be recovered. Revoke <strong>{receipt.key.name}</strong> from the key list and create a replacement.</p>}<Button onClick={onClose}>Close key receipt</Button></div> : <form className="stack-form" onSubmit={submit}><div className="developer-dialog-body">{action.kind === 'create' && <fieldset disabled={busy || ambiguous || stale}><label>Key name<Input required value={name} onChange={e => setName(e.target.value)} minLength={2} maxLength={100} placeholder="For example, nightly import" /></label><div><h3>Key permissions</h3><p className="developer-help">Within the saved account ceiling. Read includes every field in each selected object.</p><PermissionPicker value={permissions} onChange={setPermissions} objects={objects} ceiling={account.permissions} /></div></fieldset>}{action.kind !== 'revoke' && <><label>Expires after<NativeSelect value={days} disabled={busy || ambiguous || stale} onChange={e => setDays(Number(e.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>365 days</option></NativeSelect></label><PasswordField label="Current password" autoComplete="current-password" value={password} disabled={busy || stale} onChange={e => setPassword(e.target.value)} required minLength={10} maxLength={128} /></>}{ambiguous && <p className="developer-help">The earlier request may have completed. Retry this same reference with password approval, or refresh the key list. No extra key will be created on an identical retry.</p>}{stale && <p className="developer-help">This access changed. Refresh the key list and review again.</p>}</div><div className="developer-dialog-actions"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>{stale || ambiguous ? 'Refresh key list' : 'Cancel'}</Button><Button type="submit" disabled={busy || stale || action.kind === 'create' && !Object.keys(permissions).length}>{busy ? 'Working...' : ambiguous ? 'Retry same request' : action.kind === 'create' ? 'Create key' : action.kind === 'rotate' ? 'Rotate key' : 'Revoke key'}</Button></div></form>}</DialogContent></Dialog>
}
