import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { api } from '@/lib/api'
import { useWorkspace } from '@/context'
import { Button } from '@/components/ui/button'
import { ErrorState, EmptyState, LoadingPage } from '@/components/common'

type Stage = { pipeline_id: string | null; pipeline_name: string; stage_id: string | null; stage_name: string }
type Entry = { id: string; from_stage: Stage | null; to_stage: Stage; actor_name: string; created_at: string }
type History = { items: Entry[]; next_cursor: string | null }
export function DealStageHistory({ id }: { id: string }) {
  const { session } = useWorkspace()
  const [items, setItems] = useState<Entry[]>([]), [next, setNext] = useState<string | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState('')
  const attempt = useRef(0), retryCursor = useRef<string | null>(null), timezone = session.workspace.settings.timezone || 'UTC'
  const load = useCallback(async (cursor: string | null = null) => {
    const request = ++attempt.current; retryCursor.current = cursor; setBusy(true); setError('')
    try {
      const page = await api<History>(`/records/deals/${id}/stage-history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
      if (request !== attempt.current) return
      setItems(v => cursor ? [...v, ...page.items] : page.items); setNext(page.next_cursor)
    } catch (e) { if (request === attempt.current) setError((e as Error).message) }
    finally { if (request === attempt.current) setBusy(false) }
  }, [id])
  useEffect(() => { setItems([]); setNext(null); void load(); return () => { attempt.current++ } }, [load])
  return <div className="record-activity deal-stage-history"><div className="stage-history-heading"><div><h2>Stage history</h2><p>Newest first. Times in {timezone}. Earlier moves are not reconstructed.</p></div><Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>Refresh history</Button></div>{error && <ErrorState message={error} retry={() => void load(retryCursor.current)} />}{busy && !items.length ? <LoadingPage /> : !items.length && !error ? <EmptyState title="No recorded stage changes" description="New deals and future stage or pipeline changes appear here when saved." /> : <ol className="stage-history-list">{items.map(item => <li className="timeline-note" key={item.id}><ArrowRight size={16} aria-hidden="true" /><div>{item.from_stage ? <><p className="stage-history-transition"><strong>{item.from_stage.stage_name}</strong><span>to</span><strong>{item.to_stage.stage_name}</strong></p><p>{item.from_stage.pipeline_name === item.to_stage.pipeline_name && item.from_stage.pipeline_id === item.to_stage.pipeline_id ? item.to_stage.pipeline_name : `${item.from_stage.pipeline_name} to ${item.to_stage.pipeline_name}`}</p></> : <><p className="stage-history-transition"><span>Entered</span><strong>{item.to_stage.stage_name}</strong></p><p>{item.to_stage.pipeline_name}</p></>}<small>{item.actor_name}</small><time dateTime={item.created_at}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium', timeZone: timezone }).format(new Date(item.created_at))}</time></div></li>)}</ol>}{next && <Button variant="outline" disabled={busy} onClick={() => void load(next)}>{busy ? 'Loading...' : 'Load older changes'}</Button>}</div>
}
