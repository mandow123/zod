export async function refreshAfterPendingAuthentication(
  pending: Promise<void> | null,
  refresh: () => Promise<void>,
) {
  if (pending) await pending;
  await refresh();
}
