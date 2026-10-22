import type { SessionProgressInfo } from '@mylib/domain'

export interface VolumeActions {
  /** "Finished volume k": only mid-set and not waiting */
  finishVolume: { label: string } | null
  finishBookLabel: string
  /** "Waiting for volume k+1" */
  waiting: string | null
}

/** What the session card offers for finishing, given where the session is in its volume set. */
export function volumeActions(info: SessionProgressInfo): VolumeActions {
  const v = info.volume
  if (v === null) return { finishVolume: null, finishBookLabel: 'Finished', waiting: null }
  if (v.waiting) return { finishVolume: null, finishBookLabel: 'Finish reading anyway', waiting: `Waiting for volume ${v.volume + 1}` }
  if (v.volume < v.size) return { finishVolume: { label: `Finished volume ${v.volume}` }, finishBookLabel: 'Finished the book', waiting: null }
  return { finishVolume: null, finishBookLabel: 'Finished', waiting: null }
}
