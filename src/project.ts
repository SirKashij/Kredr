/** Der Name eines Projekts ist der Name seines Ordners. */
export function projectName(folder: string): string {
  const parts = folder.split(/[\\/]/).filter((part) => part !== "");
  return parts.at(-1) ?? folder;
}
