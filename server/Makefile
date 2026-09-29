# Build the Go Worker (TinyGo -> Wasm) and generate code from the proto / SQL specs.

WASM_OUT := build/app.wasm
SHIM := worker-shim/worker.mjs worker-shim/runtime.mjs worker-shim/wasm_exec.js

.PHONY: all gen proto sqlc worker dev deploy test clean

all: worker

## Code generation ---------------------------------------------------------
gen: proto sqlc

proto:            ## protobuf -> gen/go (protoc-gen-go) + ../app/src/gen (protoc-gen-es)
	buf generate

sqlc:             ## SQL -> internal/db (sqlc)
	sqlc generate

## Server -------------------------------------------------------------------
worker: $(WASM_OUT)

$(WASM_OUT): $(shell find cmd/worker internal gen/go -name '*.go' 2>/dev/null) go.mod go.sum $(SHIM)
	mkdir -p build
	cp $(SHIM) build/
	tinygo build -o $(WASM_OUT) -target wasm -no-debug ./cmd/worker
	@ls -la $(WASM_OUT) && gzip -9 -c $(WASM_OUT) | wc -c | xargs -I{} echo "gzipped: {} bytes (free plan limit 3MB)"

dev: worker        ## local dev server on :8787 (D1 emulated)
	npx wrangler dev --port 8787

deploy: worker
	npx wrangler deploy

test:
	go test ./...

clean:
	rm -rf build
