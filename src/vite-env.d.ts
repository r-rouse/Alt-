/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENAI_API_KEY: string;
  readonly VITE_OPENROUTER_API_KEY?: string;
  readonly VITE_VISION_PROVIDER?: "openai" | "openrouter";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
