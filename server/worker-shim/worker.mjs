// Worker entry point. Loads the TinyGo-compiled Go program (app.wasm) and
// forwards fetch / scheduled events to it through github.com/syumai/workers.
// Generated from `workers-assets-gen -mode=tinygo`, kept in the repo so the
// wasm_exec.js shim can be patched for the installed TinyGo version.
import "./wasm_exec.js";
import { createRuntimeContext, loadModule } from "./runtime.mjs";

let mod;

globalThis.tryCatch = (fn) => {
  try {
    return { result: fn() };
  } catch (e) {
    return { error: e };
  }
};

async function run(ctx) {
  if (mod === undefined) {
    mod = await loadModule();
  }
  const go = new Go();

  let ready;
  const readyPromise = new Promise((resolve) => {
    ready = resolve;
  });
  const instance = new WebAssembly.Instance(mod, {
    ...go.importObject,
    workers: {
      ready: () => {
        ready();
      },
    },
  });
  go.run(instance, ctx);
  await readyPromise;
}

async function fetch(req, env, ctx) {
  const binding = {};
  await run(createRuntimeContext({ env, ctx, binding }));
  return binding.handleRequest(req);
}

async function scheduled(event, env, ctx) {
  const binding = {};
  await run(createRuntimeContext({ env, ctx, binding }));
  return binding.runScheduler(event);
}

export default { fetch, scheduled };
