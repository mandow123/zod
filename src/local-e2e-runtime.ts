export async function loadLocalE2EOtp(_phone: string): Promise<string | null> {
  return null;
}

export async function loadLocalE2EDemoCatalog<T>(): Promise<T> {
  throw new Error('LOCAL_E2E_DISABLED');
}
