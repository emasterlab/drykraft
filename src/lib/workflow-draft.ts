export type DraftGroup = { id: string; label: string; nodes: string[] }
export type WorkflowDraft = { name: string; description: string; nodes: any[]; edges: any[]; groups: DraftGroup[] }
export type DraftHistory = { present: WorkflowDraft; past: WorkflowDraft[]; future: WorkflowDraft[]; key: string | null }

export function snapshot(draft: WorkflowDraft): WorkflowDraft {
  const ids = new Set(draft.nodes.map(n => n.id))
  return structuredClone({ name: draft.name, description: draft.description,
    nodes: draft.nodes.map(n => ({ id: n.id, type: 'workflow', position: n.position, data: n.data })),
    edges: draft.edges.filter(e => ids.has(e.source) && ids.has(e.target)).map(e => ({ id: e.id, source: e.source, target: e.target, ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}), ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}), ...(e.label ? { label: e.label } : {}) })),
    groups: (draft.groups || []).map(g => ({ ...g, nodes: g.nodes.filter(id => ids.has(id)) })).filter(g => g.nodes.length),
  })
}
export const fingerprint = (draft: WorkflowDraft) => JSON.stringify(snapshot(draft))
export const draftHistory = (present: WorkflowDraft): DraftHistory => ({ present, past: [], future: [], key: null })
export type DraftAction = { type: 'reset'; draft: WorkflowDraft } | { type: 'boundary' | 'undo' | 'redo' } | { type: 'edit'; update: (v: WorkflowDraft) => WorkflowDraft; key?: string }
export function draftReducer(state: DraftHistory, action: DraftAction): DraftHistory {
  if (action.type === 'reset') return draftHistory(action.draft)
  if (action.type === 'boundary') return { ...state, key: null }
  if (action.type === 'undo') return state.past.length ? { present: state.past.at(-1)!, past: state.past.slice(0, -1), future: [snapshot(state.present), ...state.future], key: null } : state
  if (action.type === 'redo') return state.future.length ? { present: state.future[0], past: [...state.past, snapshot(state.present)], future: state.future.slice(1), key: null } : state
  if (action.type !== 'edit') return state
  const next = action.update(state.present), clean = snapshot(next)
  const present = { ...next, edges: next.edges.filter(e => clean.edges.some(v => v.id === e.id)), groups: clean.groups }
  if (fingerprint(present) === fingerprint(state.present)) return { ...state, present }
  // ponytail: retain 50 draft edits in this editor session; persistent history can use saved revisions later.
  return { present, past: action.key && action.key === state.key ? state.past : [...state.past, snapshot(state.present)].slice(-50), future: [], key: action.key || null }
}
export function copySteps(draft: WorkflowDraft, selected: string[]) {
  const clean = snapshot(draft), ids = new Set(selected)
  const nodes = clean.nodes.filter(n => ids.has(n.id) && !n.data.kind.startsWith('trigger.'))
  const copied = new Set(nodes.map(n => n.id))
  return { nodes, edges: clean.edges.filter(e => copied.has(e.source) && copied.has(e.target)), groups: clean.groups.filter(g => g.nodes.every(id => copied.has(id))) }
}
export function pasteSteps(draft: WorkflowDraft, copied: ReturnType<typeof copySteps>, uuid: () => string = () => crypto.randomUUID()) {
  if (!copied.nodes.length) throw new Error('Select action or logic steps to copy. The workflow keeps its one trigger.')
  if (draft.nodes.length + copied.nodes.length > 100 || draft.edges.length + copied.edges.length > 150 || draft.groups.length + copied.groups.length > 50) throw new Error('This paste exceeds the limit of 100 steps, 150 connections or 50 groups. Copy fewer steps.')
  const ids = new Map(copied.nodes.map(n => [n.id, uuid()]))
  const bottom = Math.max(...draft.nodes.map(n => n.position.y + (n.measured?.height || 80)), ...draft.groups.map(g => { const b = groupBounds(g, draft.nodes); return b.y + b.height }))
  const top = Math.min(...copied.nodes.map(n => n.position.y), ...copied.groups.map(g => groupBounds(g, copied.nodes).y))
  const dy = bottom + 80 - top
  const nodes = copied.nodes.map(n => ({ ...structuredClone(n), id: ids.get(n.id), data: { ...structuredClone(n.data), ...(n.data.kind === 'merge' ? { splitId: ids.get(n.data.splitId) || '' } : {}) }, position: { x: n.position.x, y: n.position.y + dy }, selected: true }))
  return { ...draft, nodes: [...draft.nodes.map(n => ({ ...n, selected: false })), ...nodes], edges: [...draft.edges, ...copied.edges.map(e => ({ ...e, id: uuid(), source: ids.get(e.source), target: ids.get(e.target) }))], groups: [...draft.groups, ...copied.groups.map(g => ({ ...g, id: 'group:' + uuid(), nodes: g.nodes.map(id => ids.get(id)!) }))] }
}
export function groupBounds(group: DraftGroup, nodes: any[]) {
  const members = nodes.filter(n => group.nodes.includes(n.id))
  const x = Math.min(...members.map(n => n.position.x)) - 24, y = Math.min(...members.map(n => n.position.y)) - 48
  return { x, y, width: Math.max(...members.map(n => n.position.x + (n.measured?.width || 235))) - x + 24, height: Math.max(...members.map(n => n.position.y + (n.measured?.height || 80))) - y + 24 }
}
export function moveGroup(draft: WorkflowDraft, id: string, position: { x: number; y: number }) {
  const group = draft.groups.find(g => g.id === id)
  if (!group) return draft
  const bounds = groupBounds(group, draft.nodes), dx = position.x - bounds.x, dy = position.y - bounds.y
  return { ...draft, nodes: draft.nodes.map(n => group.nodes.includes(n.id) ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n) }
}
