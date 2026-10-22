export type CheckinFlowState = 'closed' | 'auto' | 'manual' | 'finished'

/** A check-in asked for from elsewhere (the palette): the manual flow, unless one is already open. */
export function checkinRequest(flow: CheckinFlowState): CheckinFlowState {
  return flow === 'closed' || flow === 'finished' ? 'manual' : flow
}

export function parseHomeSearch(raw: Record<string, unknown>): { checkin?: true } {
  return raw.checkin === true || raw.checkin === 'true' ? { checkin: true } : {}
}
