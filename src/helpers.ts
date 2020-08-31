export type indexSet = [number, number];

export const createIndexSet = (data: any[][]): indexSet[] =>
  data.reduce(
    (acc, item) => ({
      lastIndex: acc.lastIndex + item.length,
      built: acc.built.concat([[acc.lastIndex, acc.lastIndex + item.length]]),
    }),
    { lastIndex: 0, built: [] as indexSet[] }
  ).built;

export const mergeFromIndexSet = <T>(arr: T[], indexes: indexSet[]): T[][] =>
  indexes.map(([before, after]) => arr.slice(before, after));
