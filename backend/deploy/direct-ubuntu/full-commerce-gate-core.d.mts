export const FULL_COMMERCE_ENV_KEYS: readonly string[];
export function parseEnvironment(value: string): Record<string, string>;
export function fullCommerceConfigurationDigest(env: Record<string, string | undefined>): string;
export function fullCommerceStaticFailures(env: Record<string, string | undefined>): string[];
