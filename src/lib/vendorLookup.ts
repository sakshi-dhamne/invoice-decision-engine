// Which vendor a document belongs to, asked now rather than remembered.
//
// `invoices.vendor_id` is a seeded column. The pipeline never writes it: stage 3
// resolves the printed name against the vendor master every run and hands the
// answer to the rules, and nothing copies that answer back onto the row. So for
// every uploaded document the column is null forever, and for a seeded one it
// records whoever the vendor was when the corpus was written.
//
// Reading it as "the vendor" therefore gives a stale answer that gets worse over
// time, and the failure is the wrong way round: a vendor added five minutes ago to
// clear a hold is exactly the one the column has never heard of. That is what made
// the raise-an-order form insist there was nobody to raise an order with, and what
// left the decision page offering to add a vendor that was already there.
//
// So a screen that needs the vendor resolves it, through the same normalisation
// and fuzzy matching stage 3 uses. Same function, same thresholds, same answer.

import { resolveVendor } from '@/rules/vendor.ts'
import { toRuleSet } from '@/rules/types.ts'
import type { RuleSet, VendorRecord } from '@/rules/types.ts'
import type { VendorMatchStatus } from '@/rules/vendor.ts'
import { getRules, getVendors } from './queries.ts'
import { toVendorRecord } from './pipeline.ts'
import type { VendorRow } from './database.types.ts'

export interface ResolvedVendor {
  /** The vendor master row, or null when the printed name resolves to nobody. */
  vendor: VendorRow | null
  status: VendorMatchStatus
  /** True when the name resolved against the master rather than the stored column. */
  resolvedNow: boolean
}

/**
 * The vendor for a document, resolved against the master as it stands.
 *
 * A low-confidence match still returns its vendor. The threshold between
 * `matched` and `low_confidence` exists to make the rules engine cautious about
 * deciding on a weak match; it is not a reason to tell a person we have never
 * heard of a company whose name is sitting right there on their screen. Every
 * caller here shows the name it resolved to, so a person can see it is wrong.
 *
 * Falls back to the stored column only when the printed name resolves to nobody,
 * which covers a document whose name was never read.
 */
export function resolveVendorForDocument(input: {
  printedName: string | null | undefined
  storedVendorId: string | null | undefined
  vendors: readonly VendorRow[]
  rules: RuleSet
}): ResolvedVendor {
  const records: VendorRecord[] = input.vendors.map(toVendorRecord)
  const match = resolveVendor(input.printedName, records, input.rules)

  if (match.vendor) {
    const row = input.vendors.find((entry) => entry.id === match.vendor?.id) ?? null
    if (row) return { vendor: row, status: match.status, resolvedNow: true }
  }

  const stored = input.storedVendorId
    ? (input.vendors.find((entry) => entry.id === input.storedVendorId) ?? null)
    : null

  return { vendor: stored, status: match.status, resolvedNow: false }
}

/** The master data the resolution needs, fetched together. */
export async function loadVendorMaster(): Promise<{ vendors: VendorRow[]; rules: RuleSet }> {
  const [vendors, ruleRows] = await Promise.all([getVendors(), getRules()])
  const rules = toRuleSet(Object.fromEntries(Object.entries(ruleRows).map(([key, row]) => [key, row.value])))
  return { vendors, rules }
}
