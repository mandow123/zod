import type { Plugin } from 'vite';

export type DemoRequest = Readonly<{
  method?: string;
  url?: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}>;

export type DemoResponse = {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

export function handleAdminDemoRequest(
  request: DemoRequest,
  response: DemoResponse,
  next: () => void,
): void;

export function createAdminDemoApi(): Plugin;
