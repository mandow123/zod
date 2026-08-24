const activeOrderMutations = new Set<string>();

export function acquireStagingOrderMutation(orderId: string) {
  if (activeOrderMutations.has(orderId)) return null;
  activeOrderMutations.add(orderId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeOrderMutations.delete(orderId);
  };
}
