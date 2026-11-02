/** Main-process definition creation without loading native launch dependencies. */
export { memberIsLive } from './core/domain/teamLifecycleState';
export { NodeTeamDefinitionStore } from './main/adapters/output/NodeTeamDefinitionStore';
export {
  createNativeTeamProvisioningGraph,
  type NativeTeamProvisioningGraphDependencies,
  type NativeTeamProvisioningStores,
} from './main/composition/createNativeTeamProvisioningGraph';
export {
  createNativeTeamProvisioningRoot,
  type NativeTeamProvisioningRoot,
  type NativeTeamProvisioningRootDependencies,
} from './main/composition/createNativeTeamProvisioningRoot';

export { createNativeDefinitionStore } from './main/composition/createNativeDefinitionStore';
export { createNativeDesktopTeamRuntime } from './main/composition/createNativeDesktopTeamRuntime';
export { createNativeLanguageChangeDeps } from './main/composition/createNativeLanguageChangeDeps';
export { createNativeOpenCodeDeliveryStack } from './main/composition/createNativeOpenCodeDeliveryStack';
export { createNativeProvisioningSupport } from './main/composition/createNativeProvisioningSupport';
export { createNativeRuntimeToolApproval } from './main/composition/createNativeRuntimeToolApproval';
export { createNativeTaskActivityRepair } from './main/composition/createNativeTaskActivityRepair';
export { createNativeTeamBriefing } from './main/composition/createNativeTeamBriefing';
export { createNativeOpenCodeRuntimeControlPort } from './main/composition/createNativeOpenCodeRuntimeControlPort';
export { createNativeSecondaryRuntimeRunStore } from './main/adapters/output/NativeSecondaryRuntimeRunStore';
export { createNativeTeamHttpApis } from './main/composition/createNativeTeamHttpApis';
export { TeamOperationQueue as NativeTeamOperationQueue } from './core/application/TeamOperationQueue';
