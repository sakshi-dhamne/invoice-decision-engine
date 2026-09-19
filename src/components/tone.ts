// Colour means one thing in this product: which verdict a document reached.
//
// Every tinted surface in the app resolves its classes through here, so there is
// one place to check that nothing decorative has been coloured in.

import type { VerdictTone } from '@/lib/reasonCopy.ts'

export interface ToneClasses {
  // Filled chip: tinted background, darker ink.
  chip: string
  // A rule or left border in the verdict colour.
  border: string
  // The solid colour itself, for a bar segment.
  fill: string
  // Text in the verdict colour on the page background.
  text: string
  // Tinted panel, used by the flagged stage and the bank-details block.
  panel: string
}

const TONES: Readonly<Record<VerdictTone, ToneClasses>> = {
  approve: {
    chip: 'bg-approve-bg text-approve-ink',
    border: 'border-approve',
    fill: 'bg-approve',
    text: 'text-approve-ink',
    panel: 'bg-approve-bg border-approve',
  },
  review: {
    chip: 'bg-review-bg text-review-ink',
    border: 'border-review',
    fill: 'bg-review',
    text: 'text-review-ink',
    panel: 'bg-review-bg border-review',
  },
  hold: {
    chip: 'bg-hold-bg text-hold-ink',
    border: 'border-hold',
    fill: 'bg-hold',
    text: 'text-hold-ink',
    panel: 'bg-hold-bg border-hold',
  },
  block: {
    chip: 'bg-block-bg text-block-ink',
    border: 'border-block',
    fill: 'bg-block',
    text: 'text-block-ink',
    panel: 'bg-block-bg border-block',
  },
}

export function tone(name: VerdictTone): ToneClasses {
  return TONES[name]
}
