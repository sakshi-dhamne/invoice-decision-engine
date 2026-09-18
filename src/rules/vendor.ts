// Stage 3 — resolve the printed vendor name against the vendor master.
//
// Normalise first, then fuzzy match. Normalisation is cheap and deterministic and
// settles most apparent mismatches ("Pvt. Ltd." vs "Private Limited") before any
// scoring happens; scoring then only has to absorb genuine variation.
//
// Pure: takes the printed name and the vendor master, returns a match. No I/O.

import { companyNameSimilarity, normalizeCompanyName } from './normalize.ts'
import type { RuleSet, VendorRecord } from './types.ts'

export type VendorMatchStatus = 'matched' | 'low_confidence' | 'unresolved'

export interface VendorCandidateScore {
  vendor_id: string
  score: number
  matched_on: 'legal_name' | 'alias'
  matched_value: string
}

export interface VendorMatch {
  vendor: VendorRecord | null
  score: number
  status: VendorMatchStatus
  // Which of the master's names actually produced the score — the legal name or a
  // specific alias. Shown in the audit trail so a reviewer can see why.
  matched_on: 'legal_name' | 'alias' | null
  matched_value: string | null
  normalized_input: string
  runners_up: VendorCandidateScore[]
}

// Best score of the printed name against one vendor's legal name and every alias.
export function scoreVendor(printedName: string | null | undefined, vendor: VendorRecord): VendorCandidateScore {
  let best: VendorCandidateScore = {
    vendor_id: vendor.id,
    score: companyNameSimilarity(printedName, vendor.legal_name),
    matched_on: 'legal_name',
    matched_value: vendor.legal_name,
  }

  for (const alias of vendor.aliases) {
    const score = companyNameSimilarity(printedName, alias)
    if (score > best.score) {
      best = { vendor_id: vendor.id, score, matched_on: 'alias', matched_value: alias }
    }
  }

  return best
}

/**
 * Stage 3. Scores the printed name against every vendor and applies the two
 * thresholds from the rules table:
 *
 *   >= vendor_match_threshold  matched
 *   >= vendor_match_floor      matched, but low confidence — the flag rides
 *                              through to the decision
 *   <  vendor_match_floor      unresolved
 */
export function resolveVendor(
  printedName: string | null | undefined,
  vendors: readonly VendorRecord[],
  rules: RuleSet,
): VendorMatch {
  const normalized_input = normalizeCompanyName(printedName)

  const scored = vendors
    .map((vendor) => ({ vendor, candidate: scoreVendor(printedName, vendor) }))
    .sort((a, b) => b.candidate.score - a.candidate.score)

  const runners_up = scored.slice(1, 4).map((entry) => entry.candidate)
  const top = scored[0]

  if (!top || top.candidate.score < rules.vendor_match_floor) {
    return {
      vendor: null,
      score: top?.candidate.score ?? 0,
      status: 'unresolved',
      matched_on: null,
      matched_value: null,
      normalized_input,
      runners_up,
    }
  }

  return {
    vendor: top.vendor,
    score: top.candidate.score,
    status: top.candidate.score >= rules.vendor_match_threshold ? 'matched' : 'low_confidence',
    matched_on: top.candidate.matched_on,
    matched_value: top.candidate.matched_value,
    normalized_input,
    runners_up,
  }
}

// The remit-to check (stage 5) compares against the PO vendor's legal name using
// this same normalisation and scoring, never string equality. An abbreviated,
// differently punctuated rendering of a master name is the same payee, and a naive
// equality check would turn that into a false BLOCK.
export function namesResolveToSameEntity(
  a: string | null | undefined,
  b: string | null | undefined,
  rules: RuleSet,
): { same: boolean; score: number } {
  const score = companyNameSimilarity(a, b)
  return { same: score >= rules.vendor_match_threshold, score }
}
