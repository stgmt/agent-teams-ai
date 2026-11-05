import type { DesktopExternalAgentConnection } from '@features/external-agent-connection/main';
import type { ServiceContext } from '@main/services';

export function createIpcContextCallbacks(input: {
  rewire(context: ServiceContext): void;
  full(context: ServiceContext): void;
  connection(): DesktopExternalAgentConnection | null;
  notifyLanguageChange(language: string): Promise<void> | void;
}) {
  const connection = (): DesktopExternalAgentConnection => {
    const current = input.connection();
    if (!current) throw new Error('App connection is not available yet');
    return current;
  };
  return {
    rewire: input.rewire,
    full: input.full,
    updateClaudeRoot: (applyConfig: () => void) => connection().updateRoot(applyConfig),
    changeContext: (operation: () => Promise<void> | void) => connection().changeContext(operation),
    withLocalAdmission: async <T>(operation: () => Promise<T>): Promise<T> => {
      const current = connection();
      const expected = (await current.getConnectionInfo()).context;
      return current.withExpectedContext(expected, operation);
    },
    onAgentLanguageUpdated: (language: string): void => {
      void input.notifyLanguageChange(language);
    },
  };
}
