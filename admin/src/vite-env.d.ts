/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ADMIN_API_ORIGIN?: string;
  readonly VITE_ADMIN_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
