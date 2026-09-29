/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TREEHUB_API?: string;
  readonly VITE_TREEHUB_DEV_LOGIN?: string;
}

declare module '*.vue' {
  import type {DefineComponent} from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
