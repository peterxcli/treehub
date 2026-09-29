package api

import (
	"errors"
	"log"
	"net/http"
)

// HTTPError is an error with a client-facing status and code. Anything else a
// handler returns is logged and answered with 500 "internal".
type HTTPError struct {
	Status int
	Code   string
	Cause  error // its text becomes ErrorResponse.message
}

func (e *HTTPError) Error() string {
	if e.Cause != nil {
		return e.Code + ": " + e.Cause.Error()
	}
	return e.Code
}

func (e *HTTPError) Unwrap() error { return e.Cause }

func badRequest(code string, cause error) error {
	return &HTTPError{Status: http.StatusBadRequest, Code: code, Cause: cause}
}

func notFound(cause error) error {
	return &HTTPError{Status: http.StatusNotFound, Code: "not_found", Cause: cause}
}

func limitReached(cause error) error {
	return &HTTPError{Status: http.StatusConflict, Code: "limit_reached", Cause: cause}
}

func jsonEndpoint(handler func(*http.Request) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := handler(r)
		if err == nil {
			writeJSON(w, http.StatusOK, body)
			return
		}
		var httpErr *HTTPError
		if errors.As(err, &httpErr) {
			message := ""
			if httpErr.Cause != nil {
				message = httpErr.Cause.Error()
			}
			writeError(w, httpErr.Status, httpErr.Code, message)
			return
		}
		log.Printf("%s %s failed: %v", r.Method, r.URL.Path, err)
		writeError(w, http.StatusInternalServerError, "internal", "")
	}
}
