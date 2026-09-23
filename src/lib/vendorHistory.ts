// The first entry in a vendor's history.
//
// A vendor's change history is most useful when it starts at the beginning. If it
// only records edits, the account a vendor was created with is nowhere on the
// trail: it exists in the row until somebody changes it, and then it is gone. The
// row written here is what makes "this account has been the same since the day the
// vendor was added" a thing the history can say.

import { supabase } from './supabase.ts'
import type { VendorChangeInsert } from './database.types.ts'

export async function recordVendorCreated(input: {
  vendorId: string
  account: string
  ifsc: string
  addedBy: string
  verificationNote: string
  at: string
}): Promise<void> {
  const base = {
    vendor_id: input.vendorId,
    kind: 'created' as const,
    old_value: null,
    changed_by: input.addedBy,
    verification_note: input.verificationNote,
    changed_at: input.at,
  }

  const rows: VendorChangeInsert[] = [
    { ...base, field: 'bank_account', new_value: input.account },
    { ...base, field: 'bank_ifsc', new_value: input.ifsc },
  ]

  const { error } = await supabase.from('vendor_changes').insert(rows)
  if (error) throw error
}
