/** Status spelling returned by the spec registry; never collapse this value in DTOs. */
export type RegistryTaskStatus =
  | 'planned'
  | 'todo'
  | 'ready'
  | 'in-progress'
  | 'blocked'
  | 'done'
  | 'deleted'
  | 'deferred'
  | 'unknown';

export interface RegistryTaskSource {
  path: string | null;
  startLine: number | null;
  startColumn: number | null;
  endLine: number | null;
  endColumn: number | null;
}

/** Full `spec_entities` projection; retain fields not yet interpreted by the app. */
export interface RegistryTaskEntity {
  canonicalId: string;
  specSlug: string;
  localId: string;
  kind: string;
  title: string;
  body: string;
  attributes: Record<string, unknown>;
  contentHash: string | null;
  span: RegistryTaskSource | null;
  [field: string]: unknown;
}

/** `spec_tasks` fields retained on a shared task card. */
export interface RegistryTaskSnapshot {
  canonicalId: string;
  specSlug: string;
  localId: string;
  title: string;
  description: string | null;
  creationToken: string | null;
  status: RegistryTaskStatus;
  phase: string | null;
  owner: string | null;
  tracking: string | null;
  contentHash: string | null;
  source: RegistryTaskSource;
  requirements: string[];
  dependsOn: string[];
  blocks: string[];
  blockedBy: string[];
  body?: string;
  [field: string]: unknown;
}

export interface TeamSpecBinding {
  project: string;
  spec: string;
}

export interface RegistryRegistrationIdentity {
  securityStoreId: string;
  idp: string;
  userId: string;
}

/** Credential state the onboarding dialog may show; never carries the token. */
export interface SpecRegistryCredentialStatus {
  configured: boolean;
  url: string | null;
  source: 'store' | 'environment' | 'file' | 'none';
}

/** Result of probing a registry endpoint and token without writing. */
export interface SpecRegistryProbeResult {
  ok: boolean;
  url: string;
  toolCount: number | null;
  errorCode: string | null;
}

export interface SpecRegistryDiscovery {
  url: string;
  projects: { id: string; specs: { slug: string }[]; unavailable?: true }[];
}
