import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/common'
import { api } from '@/lib/api'
import { useWorkspace } from '@/context'

type Member = { id: string; name: string }
type Options = { items: Member[]; next_cursor: string | null; selected: Member | null }
export function UserField({ label, value = '', onChange, required = false, disabled = false, copyId = true }: { label: string; value?: string; onChange: (id: string) => void; required?: boolean; disabled?: boolean; copyId?: boolean }) {
  const id = useId(), { session, notify } = useWorkspace()
  const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [pages, setPages] = useState<string[]>([])
  const [result, setResult] = useState<Options | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPages([]) }, 250); return () => clearTimeout(timer) }, [search])
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('')
    api<Options>(`/settings/member-options?search=${encodeURIComponent(query)}${pages.length ? `&cursor=${pages.at(-1)}` : ''}${value ? `&selected=${encodeURIComponent(value)}` : ''}`, { signal: controller.signal }).then(v => { setResult(v) }).catch(e => { if (e.name !== 'AbortError') setError(e.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [query, pages, value, retry, session.workspace.id])
  const current = result?.selected?.id === value ? result.selected : result?.items.find(m => m.id === value)
  const members = result?.items || []
  const name = (member: Member) => members.some(m => m.id !== member.id && m.name === member.name) ? `${member.name} (${member.id.slice(0, 8)})` : member.name
  return <div className="member-picker">
    <label htmlFor={id}>{label}{required && <span className="required-mark"> *</span>}</label>
    <Input type="search" aria-label={`Search members for ${label}`} placeholder="Search members by name" maxLength={100} value={search} disabled={disabled} onChange={e => setSearch(e.target.value)} />
    <NativeSelect id={id} required={required} disabled={disabled} value={value} onChange={e => onChange(e.target.value)} aria-describedby={id + '-help'}>
      <option value="">{loading ? 'Loading members...' : 'No member assigned'}</option>
      {value && !members.some(m => m.id === value) && <option value={value}>{current ? name(current) : loading || error ? 'Saved assignment' : 'Former member'}</option>}
      {members.map(m => <option key={m.id} value={m.id}>{name(m)}</option>)}
    </NativeSelect>
    <small id={id + '-help'}>{value && !current && !loading && !error ? 'This saved assignment is kept as history. Choose a current member to reassign.' : !members.length && !loading && !error ? 'No members match. Try another name.' : 'Choose a current member of this workspace.'}</small>
    {(pages.length > 0 || result?.next_cursor || value || error) && <div className="member-picker-tools">
      {pages.length > 0 && <Button type="button" variant="ghost" size="sm" disabled={disabled || loading} onClick={() => setPages(p => p.slice(0, -1))}>Previous members</Button>}
      {result?.next_cursor && <Button type="button" variant="ghost" size="sm" disabled={disabled || loading} onClick={() => { if (result.next_cursor) setPages(p => [...p, result.next_cursor!]) }}>More members</Button>}
      {value && copyId && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={async () => { try { await navigator.clipboard.writeText(value); notify('Member ID copied for CSV or automation') } catch { notify('The member ID could not be copied. Allow clipboard access and try Copy member ID again.') } }}>Copy member ID</Button>}
      {error && <Button type="button" variant="outline" size="sm" disabled={disabled || loading} onClick={() => setRetry(v => v + 1)}>Retry members</Button>}
    </div>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>
}
