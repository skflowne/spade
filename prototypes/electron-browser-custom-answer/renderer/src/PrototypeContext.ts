import { createContext } from 'react'

export const BrowserCanvasContext = createContext<{
  parented: boolean
  toggleParent: () => void
}>({ parented: false, toggleParent: () => undefined })
