/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build-time endpoint overrides, a JSON object keyed by `Endpoints`
   *  field (src/config/endpoints.ts). Unset means the public hosts. */
  readonly VITE_ENDPOINTS?: string;
  /** 'restricted' pins the build to its configured endpoints; a user
   *  setting cannot loosen it. Unset means 'public'. */
  readonly VITE_EGRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
