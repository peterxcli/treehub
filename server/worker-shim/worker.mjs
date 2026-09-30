// Worker entry point. Loads the TinyGo-compiled Go program (app.wasm) and
// forwards fetch / scheduled events to it through github.com/syumai/workers.
// Generated from `workers-assets-gen -mode=tinygo`, kept in the repo so the
// wasm_exec.js shim can be patched for the installed TinyGo version.
import "./wasm_exec.js";
import { createRuntimeContext, loadModule } from "./runtime.mjs";

let mod;
// The Go program serving the requests of this isolate: a promise of its binding and memory. Starting one
// (instantiating the module, initializing the Go runtime and the handlers) costs most of the CPU time of a request,
// which the Workers free plan limits to 10ms, so it serves the following requests too. The environment is the same
// for all of them, and the Go side doesn't use the execution context of the request that started it.
let server;
// The program is built with -gc=leaking (TinyGo's garbage collector costs more CPU time than starting a new
// program): it never frees memory, so it is replaced once it has grown this much (an isolate may use 128MB).
const MAX_MEMORY = 48 * 1024 * 1024;

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
  const exited = go.run(instance, ctx);
  const memory = instance.exports.memory;
  // A program that ends (or crashes) before being ready can't serve
  const ended = exited.then(() => {
    throw new Error("The Go program ended before being ready");
  });
  ended.catch(() => {});
  await Promise.race([readyPromise, ended]);
  // (Not the promise itself: an async function would wait for it)
  return { exited, memory };
}

function startServer(env, ctx) {
  const binding = {};
  const started = run(createRuntimeContext({ env, ctx, binding })).then(({ exited, memory }) => {
    // The program doesn't end (see cmd/worker); if it does, the next request starts another one
    exited.finally(() => {
      if (server === started) server = undefined;
    });
    return { binding, memory };
  });
  return started;
}

async function fetch(req, env, ctx) {
  const current = (server = server || startServer(env, ctx));
  try {
    const { binding, memory } = await current;
    const res = await binding.handleRequest(req);
    // The next request starts a new program; this one ends with the requests it serves
    if (memory.buffer.byteLength > MAX_MEMORY && server === current) server = undefined;
    return res;
  } catch (err) {
    // E.g. a Go panic: the program can't serve more requests
    if (server === current) server = undefined;
    throw err;
  }
}

async function scheduled(event, env, ctx) {
  const binding = {};
  await run(createRuntimeContext({ env, ctx, binding }));
  return binding.runScheduler(event);
}

export default { fetch, scheduled };
