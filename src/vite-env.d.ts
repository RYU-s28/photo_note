/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_AZURE_CV_ENDPOINT?: string;
  readonly VITE_AZURE_CV_KEY?: string;
  readonly VITE_AZURE_VISION_ENDPOINT?: string;
  readonly VITE_AZURE_VISION_KEY?: string;
  readonly VITE_AZURE_VISION_LANGUAGE?: string;
  readonly VITE_BASE_PATH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
