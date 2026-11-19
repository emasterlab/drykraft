import { createContext, useContext } from 'react'
import type { Session, ObjectDefinition } from './lib/api'
export const WorkspaceContext = createContext<{ session: Session; objects: ObjectDefinition[]; reload: () => Promise<void>; notify: (message: string) => void }>(null!)
export const useWorkspace = () => useContext(WorkspaceContext)
