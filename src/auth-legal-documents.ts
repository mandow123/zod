export type FreshLegalDocumentLoad<T> = Readonly<{
  cancel: () => void;
  settled: Promise<void>;
}>;

export function startFreshLegalDocumentLoad<T>({
  reset,
  load,
  accept,
  reject,
}: Readonly<{
  reset: () => void;
  load: () => Promise<T>;
  accept: (documents: T) => void;
  reject: (reason: unknown) => void;
}>): FreshLegalDocumentLoad<T> {
  let active = true;
  reset();
  let pending: Promise<T>;
  try {
    pending = load();
  } catch (reason) {
    pending = Promise.reject(reason);
  }
  const settled = pending.then(
    (documents) => { if (active) accept(documents); },
    (reason: unknown) => { if (active) reject(reason); },
  );
  return {
    cancel: () => { active = false; },
    settled,
  };
}

export function authSubmissionDisabled({
  busy,
  externalBusy,
  canStart,
  hasDocuments,
  consented,
}: Readonly<{
  busy: boolean;
  externalBusy: boolean;
  canStart: boolean;
  hasDocuments: boolean;
  consented: boolean;
}>) {
  return busy || externalBusy || !canStart || !hasDocuments || !consented;
}
