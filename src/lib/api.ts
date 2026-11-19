export class ApiError extends Error { constructor(public status: number, message: string) { super(message) } }
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try { response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, credentials: 'same-origin' }) }
  catch (error) { if ((error as Error).name === 'AbortError') throw error; throw new ApiError(0, 'Unable to connect. Check your connection and try again.') }
  let data: any
  try { data = await response.json() } catch (error) { if ((error as Error).name === 'AbortError') throw error; throw new ApiError(response.status, response.status === 429 ? 'Too many requests. Wait a minute and try again.' : 'DryKraft could not complete this request. Please try again.') }
  if (!response.ok) throw new ApiError(response.status, data?.error?.message || 'The request could not be completed.')
  return data
}
export const send = <T = any>(path: string, body: unknown, method = 'POST') => api<T>(path, { method, body: JSON.stringify(body) })

export type Field = { key: string; name: string; type: string; required: boolean; options?: string[]; object?: string }
export type ObjectDefinition = { key: string; name: string; singular_name: string; fields: Field[]; built_in: boolean; managed_field_keys?: string[] }
export type RecordItem = { id: string; object_key: string; user_names?: Record<string, string>; relation_names?: Record<string, {id:string;name:string;object_key:string}>; data: Record<string, any>; version: number; created_at: string; updated_at: string }
export type RecordFilter = { match: 'all' | 'any'; conditions: { field: string; operator: string; value?: string | number | boolean }[] }
export type RecordList = { id: string; object_key: string; name: string; filter: RecordFilter; version: number }
export type CurrencyOption = { code: string; name: string; symbol: string; digits: number }
export type Session = { platform?: {support_email:string;maintenance_message:string}; domain: string; subdomain_routing: boolean; currency_options: CurrencyOption[]; user: { id: string; name: string; email: string }; workspace: { id: string; name: string; slug: string; settings: { currency?: string; currencies?: string[]; timezone?: string; demo?: boolean } }; role: string; workspaces: { id: string; name: string; slug: string; role: string }[] }
export type PendingSession = Omit<Session, 'workspace' | 'role'> & { workspace: null; role: null }
export const workspaceRoles = {
  admin: { name: 'Administrator', description: 'Manage workspace settings, workflows and member access.' },
  member: { name: 'Member', description: 'Create and update business records, dashboards and workflow drafts.' },
  viewer: { name: 'Read only', description: 'View workspace data without changing it.' },
} as const
export type Stage = { id: string; name: string; probability: number; color: string }
export type Pipeline = { id: string; name: string; stages: Stage[] }
export type Widget = { id: string; title: string; object: string; operation: 'count' | 'sum' | 'avg'; field?: string; group_by?: string; display: 'metric' | 'bar' | 'donut'; currency?: string; filter?: { field: string; value: string }; date_range?: { period: 'custom' | 'today' | 'last_7_days' | 'last_30_days' | 'this_month' | 'last_month'; source: 'created_at' | 'updated_at' | 'field'; field?: string; from?: string; to?: string } }
export type Dashboard = { id: string; name: string; widgets: Widget[]; version: number }
export type Workflow = { id: string; name: string; description: string; draft: { nodes: any[]; edges: any[] }; published_version_id: string | null; status: 'draft' | 'active' | 'paused'; executions: number; updated_at: string }
export function money(value: number, currency = 'USD', compact = false) { return new Intl.NumberFormat('en-US', { style: 'currency', currency, ...(compact ? { notation: 'compact' as const, maximumFractionDigits: 1 } : {}) }).format(value) }
export function initials(name: string) { return name.split(/\s+/).slice(0, 2).map(n => n[0]).join('').toUpperCase() }
export function humanDate(date: string) { return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00` : date)) }
