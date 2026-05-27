import 'katex/dist/katex.min.css'
import './styles/globals.css'
import './styles/colors_and_type.css'
import { QueryClientProvider } from '@tanstack/react-query'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { queryClient } from './lib/query-client'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
)
