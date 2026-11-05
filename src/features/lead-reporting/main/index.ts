import { LeadReporting } from '../core/application/LeadReporting';

import type { LeadReportDependencies } from '../core/application/ports';

export type {
  LeadReportDependencies,
  LeadReportSources,
  ResultsRead,
  RosterRead,
  TasksRead,
} from '../core/application/ports';
export { reportScopeForHumanRequest } from '../core/domain/reportRequestIntent';
export { registerLeadReportingHttp } from './adapters/input/registerLeadReportingHttp';
export { NodeLeadReportDelivery } from './adapters/output/NodeLeadReportDelivery';
export { NodeLeadReportSources } from './adapters/output/NodeLeadReportSources';
export { LeadRequestReporting } from './application/LeadRequestReporting';
export {
  buildEvidenceBasedLeadReplyInstruction,
  buildLeadReportContextRefresh,
  buildLeadReportRequestInstruction,
  buildLeadServiceRefreshInstruction,
} from './application/reportInstructions';
export {
  createNodeLeadReporting,
  type NodeLeadReporting,
} from './composition/createNodeLeadReporting';

export function createLeadReportingFeature(deps: LeadReportDependencies): LeadReporting {
  return new LeadReporting(deps);
}
