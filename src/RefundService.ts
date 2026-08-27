export interface RefundRequest {
  amount: number;
}

export type RefundDecision = 'AUTOMATICALLY_APPROVED' | 'PENDING_REVIEW';

export function decideRefund(refund: RefundRequest): RefundDecision {
  if (refund.amount > 5_000) {
    return 'AUTOMATICALLY_APPROVED';
  }

  return 'PENDING_REVIEW';
}
