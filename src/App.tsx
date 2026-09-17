import ExtractionHarness from '@/pages/ExtractionHarness'
import Home from '@/pages/Home'

function App() {
  if (window.location.pathname === '/harness') {
    return <ExtractionHarness />
  }
  return <Home />
}

export default App
