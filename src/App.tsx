import { BrowserRouter, Route, Routes } from 'react-router-dom'

import { UploadProvider } from '@/components/UploadProvider.tsx'

import Dashboard from '@/pages/Dashboard'
import Decision from '@/pages/Decision'
import Exceptions from '@/pages/Exceptions'
import ExtractionHarness from '@/pages/ExtractionHarness'
import NotFound from '@/pages/NotFound'
import OrderDetail from '@/pages/OrderDetail'
import OrderNew from '@/pages/OrderNew'
import Orders from '@/pages/Orders'
import Process from '@/pages/Process'
import RunLive from '@/pages/RunLive'
import Rules from '@/pages/Rules'
import VendorEdit from '@/pages/VendorEdit'
import VendorNew from '@/pages/VendorNew'
import Vendors from '@/pages/Vendors'

function App() {
  return (
    <BrowserRouter>
      <UploadProvider>
      <Routes>
        <Route path="/" element={<Exceptions />} />
        <Route path="/runs/:id" element={<RunLive />} />
        <Route path="/decisions/:id" element={<Decision />} />
        <Route path="/vendors" element={<Vendors />} />
        <Route path="/vendors/new" element={<VendorNew />} />
        <Route path="/vendors/:id/edit" element={<VendorEdit />} />
        <Route path="/orders" element={<Orders />} />
        {/* Declared before the order number so "new" is never read as one. */}
        <Route path="/orders/new" element={<OrderNew />} />
        <Route path="/orders/:poNumber" element={<OrderDetail />} />
        <Route path="/controls" element={<Rules />} />
        <Route path="/invoices" element={<Dashboard />} />
        <Route path="/process" element={<Process />} />

        {/* The names these pages used to live under, kept so an old link still
            lands somewhere. */}
        <Route path="/rules" element={<Rules />} />
        <Route path="/dashboard" element={<Dashboard />} />

        {/* The development harness, unchanged. It is not part of the product and
            carries none of its chrome. */}
        <Route path="/harness" element={<ExtractionHarness />} />

        <Route path="*" element={<NotFound />} />
      </Routes>
      </UploadProvider>
    </BrowserRouter>
  )
}

export default App
