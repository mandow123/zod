export type HostPreflightArguments = {
  'private-ip': string;
  baseline: string;
  report: string;
};

export function parseArguments(values: string[]): HostPreflightArguments;
export function isVpcPrivateIpv4(value: string): boolean;
export function parseEnvironmentFile(source: string): Record<string, string>;
export function listeningCloudPayPorts(source: string): number[];
