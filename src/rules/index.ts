// Invoice Decision Engine — rules engine.
//
// ---------------------------------------------------------------------------
// The model extracts and phrases. Deterministic code decides.
//
// No model output reaches a verdict. Every rule in this directory is pure
// TypeScript operating on already-extracted data plus database records. Stage 7
// calls a model only to turn a settled verdict into a readable sentence — it
// cannot change the outcome, and a failed call never fails a run.
// ---------------------------------------------------------------------------
//
// Every function exported here is pure: inputs in, result out, no database
// access, no I/O, no clock. `src/lib/pipeline.ts` does the fetching and the
// writing. That separation is what makes the whole engine testable with no
// network.
//
// The rules are general. Nothing in this directory branches on a particular
// invoice number, vendor, purchase order or any other corpus-specific string — an
// invoice from a company that appears in no fixture flows through the identical
// code path.

export * from './types.ts'
export * from './normalize.ts'
export * from './vendor.ts'
export * from './poMatch.ts'
export * from './validate.ts'
export * from './decide.ts'
export * from './explain.ts'
