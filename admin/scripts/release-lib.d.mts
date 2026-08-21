export const BUNDLE_DIRECTORY: string;
export const MANIFEST_FILE: string;
export const METADATA_FILE: string;

export function canonicalHttpsOrigin(value: unknown, name?: string): string;
export function assertReleasePath(relativePath: unknown): string;
export function sha256(bytes: Uint8Array | string): string;
export function formatManifest(records: ReadonlyArray<Readonly<{ path: string; digest: string }>>): string;
export function listFiles(rootDirectory: string): Promise<string[]>;
export function createManifest(rootDirectory: string): Promise<string>;
export function verifyRelease(
  rootDirectory: string,
  options?: Readonly<{ expectedOrigin?: string; requireExpectedOrigin?: boolean }>,
): Promise<Readonly<{ buildOrigin: string; fileCount: number }>>;
export function createDeterministicTarGzip(rootDirectory: string): Promise<Uint8Array>;
