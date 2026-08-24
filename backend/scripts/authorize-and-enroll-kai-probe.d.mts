export type ProbeEnrollmentArguments = Readonly<{
  identityFile: string;
  host: '43.198.97.0';
  remoteScript: string;
}>;

export function parseEnrollmentArguments(argv: string[]): ProbeEnrollmentArguments;
export function authorizeAndEnroll(argv?: string[]): Promise<void>;
