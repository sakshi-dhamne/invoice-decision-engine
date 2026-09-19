import { BrowserRouter, Route, Routes } from 'react-router-dom'

import Dashboard from '@/pages/Dashboard'
import Decision from '@/pages/Decision'
import ExtractionHarness from '@/pages/ExtractionHarness'
import NeedsYou from '@/pages/NeedsYou'
import NotFound from '@/pages/NotFound'
import RunLive from '@/pages/RunLive'
import Rules from '@/pages/Rules'
import VendorNew from '@/pages/VendorNew'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<NeedsYou />} />
        <Route path="/runs/:id" element={<RunLive />} />
        <Route path="/decisions/:id" element={<Decision />} />
        <Route path="/vendors/new" element={<VendorNew />} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/dashboard" element={<Dashboard />} />

        {/* The development harness, unchanged. It is not part of the product and
            carries none of its chrome. */}
        <Route path="/harness" element={<ExtractionHarness />} />

        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
