const PARENT_GIT_SELECTION_KEYS = new Set([
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
]);

/** Repository selection belongs to the resolved workspace, not the launching shell. */
export function withoutParentGitSelection(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !PARENT_GIT_SELECTION_KEYS.has(key.toUpperCase()))
  );
}
