/** Main-process definition creation without loading native launch dependencies. */
export { memberIsLive } from './core/domain/teamLifecycleState';
export { NodeTeamDefinitionStore } from './main/adapters/output/NodeTeamDefinitionStore';
export {
  createNativeTeamProvisioningRoot,
  type NativeTeamProvisioningRoot,
  type NativeTeamProvisioningRootDependencies,
} from './main/composition/createNativeTeamProvisioningRoot';
