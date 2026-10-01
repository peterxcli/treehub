//go:build js && wasm

package main

import (
	"database/sql"
	"log"
	"net/http"

	"github.com/syumai/workers"
	"github.com/syumai/workers/cloudflare"
	"github.com/syumai/workers/cloudflare/d1"
	"github.com/syumai/workers/cloudflare/fetch"

	"github.com/peterxcli/treehub/server/internal/api"
	"github.com/peterxcli/treehub/server/internal/auth"
	"github.com/peterxcli/treehub/server/internal/db"
)

// One Go instance serves the requests of an isolate until its memory has grown
// (see worker-shim/worker.mjs): the setup below runs once per instance, and the
// program then serves requests until it is replaced or the isolate goes away.
// (workers.Serve would end it after the first response.) The handlers must not
// keep state between requests.
func run() {
	h, err := newHandler()
	if err != nil {
		// Answer with the reason instead of exiting: an exited instance never
		// signals ready, so the request would hang instead of failing.
		log.Printf("worker setup: %v", err)
		h = api.Unavailable(err.Error())
	}
	workers.ServeNonBlock(h)
	workers.Ready()
	select {}
}

func newHandler() (http.Handler, error) {
	connector, err := d1.OpenConnector("DB")
	if err != nil {
		return nil, err
	}
	sessions, err := auth.NewSessions(cloudflare.Getenv("SESSION_SECRET"))
	if err != nil {
		return nil, err
	}
	sqlDB := sql.OpenDB(connector)
	srv := &api.Server{
		Q:        db.New(sqlDB),
		DB:       sqlDB,
		Sessions: sessions,
		GitHub: &auth.GitHub{
			ClientID:     cloudflare.Getenv("GITHUB_CLIENT_ID"),
			ClientSecret: cloudflare.Getenv("GITHUB_CLIENT_SECRET"),
			HTTP:         fetch.NewClient().HTTPClient(fetch.RedirectModeFollow),
		},
		Cfg: api.Config{
			AllowedExtensionIDs: api.ParseList(cloudflare.Getenv("ALLOWED_EXTENSION_IDS")),
			DevAuth:             cloudflare.Getenv("DEV_AUTH") == "true",
			MaxBookmarks:        api.DefaultMaxBookmarks,
			MaxQueueItems:       api.DefaultMaxQueueItems,
			MaxHistoryItems:     api.DefaultMaxHistoryItems,
		},
	}
	return srv.Handler(), nil
}
