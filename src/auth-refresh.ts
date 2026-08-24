export async function refreshAfterPendingAuthentication(
  pending: Promise<void> | null,
  refresh: () => Promise<void>,
) {
  if (pending) await pending;
  await refresh();
}

export function promoteStoredAuthentication<Snapshot extends object, User>(snapshot: Snapshot, user: User) {
  return { ...snapshot, authenticated: true as const, user, sessionState: 'offline' as const };
}

export async function finishStoredAuthenticationCommit<Session>(
  session: Session,
  cleanupPreviousIdentity: () => Promise<void>,
) {
  try { await cleanupPreviousIdentity(); } catch {
    // The encrypted StoredSession is the durable commit marker. Startup and
    // foreground reconciliation retry this cleanup without rolling it back.
  }
  return session;
}

export async function publishStoredAuthentication<Session>(
  pending: Promise<void> | null,
  session: Session,
  publish: (session: Session) => void,
  refresh: () => Promise<void>,
) {
  // The caller's forced refresh advances its generation synchronously, so the
  // older guest read may finish but cannot publish over this stored session.
  void pending?.catch(() => undefined);
  publish(session);
  try {
    await refresh();
    return { session, refreshed: true as const };
  } catch {
    return { session, refreshed: false as const };
  }
}
