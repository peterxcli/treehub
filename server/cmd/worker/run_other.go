//go:build !(js && wasm)

package main

import (
	"fmt"
	"os"
)

func run() {
	fmt.Fprintln(os.Stderr, "treehub worker only runs on Cloudflare Workers; build it with `make worker` (TinyGo -> Wasm).")
	os.Exit(2)
}
