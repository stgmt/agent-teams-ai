import * as controllerModuleNs from 'agent-teams-controller';

type ControllerModule = typeof controllerModuleNs;

function isControllerModule(value: unknown): value is ControllerModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'createController' in value &&
    typeof value.createController === 'function'
  );
}

/**
 * `agent-teams-controller` is compiled as CommonJS, so the interop namespace may or
 * may not expose a usable `default`. The presence check has to happen before the
 * read: a partial ESM mock throws on reading an export it does not define, which
 * turned a harmless fallback into a module-load failure.
 */
const interopDefault: unknown =
  'default' in controllerModuleNs ? Reflect.get(controllerModuleNs, 'default') : undefined;

export const controllerModule: ControllerModule = isControllerModule(interopDefault)
  ? interopDefault
  : controllerModuleNs;
