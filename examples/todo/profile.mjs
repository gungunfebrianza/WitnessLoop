const rowsOf = (world) => (world.page.indexedDB?.['todo-db']?.stores?.todos?.rows ?? []).map((r) => r.value);

export const profile = {
  name: 'todo',
  volatileKeys: ['created'], // creation timestamps differ between a run and its replay
  // No item may be marked done that was never added: a trivially checkable page-state invariant.
  invariant: (world) => {
    const rows = world.page.indexedDB?.['todo-db']?.stores?.todos?.rows ?? [];
    const titles = rows.map((r) => r.value.title);
    return new Set(titles).size === titles.length ? { ok: true } : { ok: false, why: 'duplicate todo titles' };
  },
  // What the dashboard's world tab draws at each checkpoint: open vs done, and how many titles are duplicates.
  metrics: (world) => {
    const rows = rowsOf(world); const seen = new Set();
    const items = rows.map((r) => { const dup = seen.has(r.title); seen.add(r.title); return { label: `#${r.id} ${r.title}${r.done ? ' (done)' : ''}`, amount: r.id, delta: dup ? 1 : 0 }; });
    return {
      title: 'Todos', unit: 'items', parts: { open: rows.filter((r) => !r.done).length, done: rows.filter((r) => r.done).length }, total: rows.length,
      deviation: items.reduce((a, x) => a + x.delta, 0), deviationTitle: 'Duplicate titles',
      deviationNote: 'This is the invariant drawn as a number: extra rows whose title already exists. The Incident tab shows the same first failure through bisect.',
      itemsTitle: 'Every todo at the last checkpoint', itemsNoun: 'todos', itemCols: ['id', 'duplicate'], items,
    };
  },
};
export default profile;
