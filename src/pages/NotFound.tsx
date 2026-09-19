import { Link } from 'react-router-dom'

import { AppShell } from '@/components/AppShell.tsx'
import { EmptyState, Panel } from '@/components/Primitives.tsx'
import { Button } from '@/components/ui/button'

export default function NotFound() {
  return (
    <AppShell>
      <Panel>
        <EmptyState
          action={
            <Button asChild>
              <Link to="/">Go to the queue</Link>
            </Button>
          }
        >
          There is nothing at this address. Open an invoice from the queue to see its decision.
        </EmptyState>
      </Panel>
    </AppShell>
  )
}
