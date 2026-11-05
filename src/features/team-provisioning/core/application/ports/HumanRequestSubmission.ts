import type { LeadRequestDeliveryReceipt } from '../../../contracts';

export interface HumanRequestSubmission {
  submit(input: unknown): Promise<LeadRequestDeliveryReceipt>;
}
