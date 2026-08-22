export function formatModelDisplayName(
  providerId: string,
  modelName: string,
): string {
  const name = modelName.trim() || providerId;
  if (name === providerId || name.startsWith(`${providerId}/`)) return name;
  return `${providerId}/${name}`;
}
