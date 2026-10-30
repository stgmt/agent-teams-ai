import type { TeamRunIdentity } from '../../../contracts';
import type { LeadInputDelivery } from './LeadInputDelivery';

/** Supplied by the app's persisted human-message boundary, never reconstructed from model text. */
export interface PersistedLeadRequest {
  readonly run: Readonly<TeamRunIdentity>;
  readonly requestMessageId: string;
  readonly text: string;
  readonly origin: Readonly<{ kind: 'human' }>;
  readonly isMeta: false;
}

export interface LeadRequestDeliveryPorts {
  assertCurrent(run: Readonly<TeamRunIdentity>): void;
  read(
    run: Readonly<TeamRunIdentity>,
    requestMessageId: string
  ): Promise<PersistedLeadRequest | null>;
  readDelivered(run: Readonly<TeamRunIdentity>, requestMessageId: string): Promise<string | null>;
  input: LeadInputDelivery;
  accept(request: PersistedLeadRequest): Promise<string>;
  send(run: Readonly<TeamRunIdentity>, text: string): Promise<void>;
}
