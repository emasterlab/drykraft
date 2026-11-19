import { AlertCircle, Plus, SearchX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export function PageHeading({ title, description, children }: { title: string; description?: string; children?: React.ReactNode }) { return <div className="page-heading"><div><h1>{title}</h1>{description && <p>{description}</p>}</div><div className="page-actions">{children}</div></div> }
export function EmptyState({ title, description, action, icon: Icon = SearchX }: { title: string; description: string; action?: React.ReactNode; icon?: typeof SearchX }) { return <div className="empty-state"><span className="empty-icon"><Icon size={26} strokeWidth={1.5} /></span><h2>{title}</h2><p>{description}</p>{action}</div> }
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) { return <div className="error-state" role="alert"><AlertCircle size={18} /><span>{message}</span>{retry && <Button variant="outline" size="sm" onClick={retry}>Try again</Button>}</div> }
export function LoadingPage() { return <div className="loading-page" role="status" aria-live="polite"><span className="sr-only">Loading workspace data...</span><Skeleton className="h-8 w-64" /><div className="loading-metrics">{[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-28" />)}</div><Skeleton className="h-80" /></div> }
export function Status({ value }: { value: string }) { return <span className={`status status-${value.toLowerCase().replace(/\s/g, '-')}`}><span />{value}</span> }
export function AddButton({ children, ...props }: React.ComponentProps<typeof Button>) { return <Button {...props}><Plus size={16} />{children}</Button> }
export const NativeSelect = ({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) => <select className="native-select" {...props}>{children}</select>
