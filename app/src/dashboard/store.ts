// Dashboard state: a reactive copy of the shared state (lib/storage.ts) that follows its changes, plus the
// requests to the background worker and the toasts that report their results.
import {reactive, ref} from 'vue';
import {send, type Request} from '../lib/messages.ts';
import {load, subscribe, type State} from '../lib/storage.ts';

export const state = reactive<State>({});
export const loaded = ref(false);

/** Current time, ticking so that relative times ("5 minutes ago") stay current. */
export const clock = ref(Date.now());
setInterval(() => (clock.value = Date.now()), 30 * 1000);

export async function init(): Promise<void> {
  subscribe((changes) => Object.assign(state, changes));
  Object.assign(state, await load());
  loaded.value = true;
}

// ---------- Toasts ----------

export interface Toast {
  id: number;
  message: string;
  error?: boolean;
  action?: {label: string; run: () => void};
}

export const toasts = ref<Toast[]>([]);
let toastId = 0;

export function toast(message: string, options: {error?: boolean; action?: Toast['action']; ms?: number} = {}): void {
  const id = ++toastId;
  toasts.value = [...toasts.value.slice(-2), {id, message, error: options.error, action: options.action}];
  setTimeout(() => dismiss(id), options.ms || (options.error ? 8000 : 5000));
}

export function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

// ---------- Requests ----------

/** Pending requests by name, e.g. busy['refresh'] while refreshing. */
export const busy = reactive<Record<string, boolean>>({});

/** Sends a request to the background worker; failures are shown as a toast and return undefined. */
export async function request<T = unknown>(name: string, message: Request): Promise<T | undefined> {
  busy[name] = true;
  try {
    return await send<T>(message);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), {error: true});
    return undefined;
  } finally {
    delete busy[name];
  }
}
