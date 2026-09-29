package api

import (
	"context"
	"net/http"
	"strings"
)

// router is a minimal method + path router with {name} and {name...} wildcards.
// TinyGo's net/http ships a pre-Go-1.22 ServeMux without method patterns, so
// the API cannot rely on "GET /path/{id}" registrations; this keeps routing
// identical on the host and in Wasm.
type router struct {
	routes []route
}

type route struct {
	method   string
	segments []string // literal, "{name}" or "{name...}"
	handler  http.HandlerFunc
}

type paramsKey struct{}

func (rt *router) handle(method, pattern string, h http.HandlerFunc) {
	rt.routes = append(rt.routes, route{method: method, segments: splitPath(pattern), handler: h})
}

func splitPath(p string) []string {
	p = strings.Trim(p, "/")
	if p == "" {
		return nil
	}
	return strings.Split(p, "/")
}

// match returns the captured params, or nil when the path does not match.
func (r route) match(path []string) (map[string]string, bool) {
	params := map[string]string{}
	for i, seg := range r.segments {
		if strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "...}") {
			params[seg[1:len(seg)-4]] = strings.Join(path[i:], "/")
			return params, len(path) > i
		}
		if i >= len(path) {
			return nil, false
		}
		if strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "}") {
			params[seg[1:len(seg)-1]] = path[i]
			continue
		}
		if seg != path[i] {
			return nil, false
		}
	}
	return params, len(path) == len(r.segments)
}

func (rt *router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := splitPath(r.URL.Path)
	pathMatched := false
	for _, ro := range rt.routes {
		params, ok := ro.match(path)
		if !ok {
			continue
		}
		pathMatched = true
		if ro.method != r.Method {
			continue
		}
		ro.handler(w, r.WithContext(context.WithValue(r.Context(), paramsKey{}, params)))
		return
	}
	if pathMatched {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "")
		return
	}
	writeError(w, http.StatusNotFound, "not_found", "")
}

// param returns a path wildcard captured by the router ("" when absent).
func param(r *http.Request, name string) string {
	if m, ok := r.Context().Value(paramsKey{}).(map[string]string); ok {
		return m[name]
	}
	return ""
}
