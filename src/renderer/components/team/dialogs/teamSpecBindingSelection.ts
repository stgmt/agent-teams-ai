export function registrySelectionKey(project: string, slug: string): string {
  return JSON.stringify([project, slug]);
}

export function isTeamSpecBindingSelectionValid(
  project: string,
  slug: string,
  selectedKey: string | null
): boolean {
  const normalizedProject = project.trim();
  const normalizedSlug = slug.trim();

  if (!normalizedProject && !normalizedSlug) return true;
  if (!normalizedProject || selectedKey === null) return false;
  return selectedKey === registrySelectionKey(normalizedProject, normalizedSlug);
}
