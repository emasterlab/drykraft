import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import '@fontsource-variable/inter'
import './index.css'
import { App } from './App'

const router = createBrowserRouter([{ path: '*', element: <TooltipProvider delayDuration={250}><App /></TooltipProvider> }])
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><RouterProvider router={router} /></React.StrictMode>)
