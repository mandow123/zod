import type { ReactNode } from 'react';

export type StagingProfileEntry = Readonly<{
  count?: number;
  label: string;
  meta: string;
  onPress: () => void;
}>;

export function useStagingProfileToolsSlot(): Readonly<{
  draftEntry: StagingProfileEntry | null;
  sshEntry: StagingProfileEntry | null;
  connectionEntry: StagingProfileEntry | null;
  sheets: ReactNode;
}> {
  return { draftEntry: null, sshEntry: null, connectionEntry: null, sheets: null };
}
