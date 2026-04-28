export const normalizeDirectorySlug = (value: string): string => value
  .trim()
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/&/g, ' and ')
  .replace(/[.'’`]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '');

export const normalizeDirectoryList = (value: string[] | undefined): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(
    value
      .map((item) => normalizeDirectorySlug(item))
      .filter((item) => item.length > 0),
  ));
};
