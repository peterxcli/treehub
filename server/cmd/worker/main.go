// The Cloudflare Worker entry point. Compiled with TinyGo to Wasm (see
// Makefile) and loaded by worker-shim/worker.mjs. The real wiring lives in
// run_js.go; on any other platform the binary only prints a hint, which keeps
// `go vet ./...` and `go build ./...` working on the host.
package main

func main() {
	run()
}
