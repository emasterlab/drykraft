import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { send } from '@/lib/api'

type Grant = { token: string; mode: 'read' | 'write'; expires_at: string }

export function McpAccess({ canWrite, sample }: { canWrite: boolean; sample: boolean }) {
  const [mode, setMode] = useState<Grant['mode']>('read')
  const [grant, setGrant] = useState<Grant>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function update(revoke: boolean) {
    setBusy(true)
    setMessage('')
    setError('')
    try {
      if (revoke) {
        await send('/account/mcp-access', {}, 'DELETE')
        setGrant(undefined)
        setMessage('MCP access revoked.')
      } else {
        setGrant(await send<Grant>('/account/mcp-access', { mode }))
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return <section className="security-section stack-form" aria-labelledby="mcp-access-heading">
    <div className="security-section-heading">
      <h2 id="mcp-access-heading">MCP access</h2>
      <p>Connect an AI assistant using the hosted <a href="https://drykraft.com/mcp" target="_blank" rel="noreferrer">MCP setup guide</a>. Access follows your workspace role.</p>
    </div>
    {sample ? <p>Create a workspace to use MCP access.</p> : <>
      <label>Access level
        <select className="native-select" value={mode} onChange={e => setMode(e.target.value as Grant['mode'])}>
          <option value="read">Read only</option>
          {canWrite && <option value="write">Read and write</option>}
        </select>
      </label>
      {mode === 'write' && <p>Write access lets your agent change workspace records and run approved actions.</p>}
      <div className="outreach-actions">
        <Button type="button" disabled={busy} onClick={() => void update(false)}>Create manual token</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void update(true)}>Revoke access</Button>
      </div>
      <p>Connecting a new client or creating a manual token replaces MCP access for this browser session.</p>
      {grant && <div className="stack-form">
        <label>MCP token<Input value={grant.token} readOnly spellCheck={false} onFocus={e => e.target.select()} /></label>
        <small>Copy it now. It will only be shown here. Expires {new Date(grant.expires_at).toLocaleString()}.</small>
      </div>}
      {message && <p role="status">{message}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </>}
  </section>
}
