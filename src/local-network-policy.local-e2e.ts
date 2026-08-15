const LOCAL_E2E_HOSTS = new Set(['10.0.2.2', '127.0.0.1', 'localhost']);

export function allowsInsecureLocalE2EHost(hostname: string): boolean {
  return LOCAL_E2E_HOSTS.has(hostname);
}
