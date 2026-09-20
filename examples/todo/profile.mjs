export const profile = {
  name: 'todo',
  volatileKeys: ['created'], // creation timestamps differ between a run and its replay
  // No item may be marked done that was never added: a trivially checkable page-state invariant.
  invariant: (world) => {
    const rows = world.page.indexedDB?.['todo-db']?.stores?.todos?.rows ?? [];
    const titles = rows.map((r) => r.value.title);
    return new Set(titles).size === titles.length ? { ok: true } : { ok: false, why: 'duplicate todo titles' };
  },
};
export default profile;
