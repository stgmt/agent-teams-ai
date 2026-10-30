import type { TeamLifecycleStopRequest } from './api';

export interface LeadHumanRequest extends TeamLifecycleStopRequest {
  requestMessageId: string;
  text: string;
}

export interface LeadRequestDeliveryReceipt {
  readonly requestMessageId: string;
  readonly state: 'queued' | 'sent' | 'delivered';
}

export interface LeadHumanRequestApi {
  submitHumanRequest(request: LeadHumanRequest): Promise<LeadRequestDeliveryReceipt>;
}

export const TEAM_SUBMIT_HUMAN_REQUEST = 'team:lifecycle:submit-human-request';
