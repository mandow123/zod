export type SidecarProbe = {
  origin: string;
  ok: boolean;
  records: Array<{ path: string; status: number; contentType: string; bytes: number }>;
  signatures: Record<string, { status: number; contentType: string; service: string | null; apiVersion: string | null; errorCode: string | null }>;
  failures: string[];
};

export function probeOrigin(origin: string): Promise<SidecarProbe>;
export function compareProbeSignatures(loopback: SidecarProbe, edge: SidecarProbe): string[];
