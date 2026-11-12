import type { PersistedLeadRequest } from './LeadRequestDeliveryPorts';

export type LeadInputClaim =
  | Readonly<{ state: 'claimed'; operationId: string }>
  | Readonly<{ state: 'sent' }>
  | Readonly<{ state: 'unconfirmed'; operationId: string }>;

/** Durable admission already has an older human request without a confirmed reply. */
export class PreviousDurableRequestActiveError extends Error {
  constructor() {
    super('Previous durable human request is still active');
  }
}

/** Durable input intent belongs to the original human request, not to model turn completion. */
export interface LeadInputDelivery {
  reserve(request: PersistedLeadRequest): Promise<void>;
  claim(request: PersistedLeadRequest): Promise<LeadInputClaim>;
  sent(request: PersistedLeadRequest, operationId: string): Promise<void>;
}
