// Pure bounded DAG fold over canonical inspection rows. References outside this view are not fake executed nodes.
export function processLayout(
  rows: readonly { workKey: string; prerequisites: readonly { workKey: string; binding: string }[] }[],
): string[][] {
  if (rows.length > 2000) throw Error('process limit');
  const nodes = new Map(rows.map((r) => [r.workKey, r])),
    degree = new Map<string, number>(),
    next = new Map<string, string[]>();
  if (nodes.size !== rows.length) throw Error('duplicate work');
  let edges = 0;
  for (const row of rows) {
    let n = 0;
    for (const dep of row.prerequisites) {
      if (++edges > 10000) throw Error('process edge limit');
      if (dep.binding !== 'in-view') continue;
      if (!nodes.has(dep.workKey)) throw Error('missing dependency');
      n++;
      const out = next.get(dep.workKey) ?? [];
      out.push(row.workKey);
      next.set(dep.workKey, out);
    }
    degree.set(row.workKey, n);
  }
  let ready = rows.filter((r) => degree.get(r.workKey) === 0).map((r) => r.workKey),
    seen = 0;
  const levels: string[][] = [];
  while (ready.length) {
    levels.push(ready);
    seen += ready.length;
    const following: string[] = [];
    for (const key of ready)
      for (const target of next.get(key) ?? []) {
        const n = degree.get(target)! - 1;
        degree.set(target, n);
        if (n === 0) following.push(target);
      }
    ready = following;
  }
  if (seen !== rows.length) throw Error('cyclic work');
  return levels;
}
