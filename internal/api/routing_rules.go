package api

import (
	"errors"
	"io"
	"net/http"

	"github.com/HengXin666/hx-pxy/internal/routingrules"
)

func (s *Server) handleRoutingRules(writer http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		config, err := s.routingRules.Get(request.Context())
		if err != nil {
			s.handleError(writer, request, err)
			return
		}
		writeJSON(writer, http.StatusOK, config)
	case http.MethodPut:
		var body routingrules.Config
		if err := decodeJSONBody(writer, request, &body); err != nil {
			s.writeAPIError(writer, request, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}
		config, err := s.routingRules.Update(request.Context(), body)
		if err != nil {
			s.handleError(writer, request, err)
			return
		}
		writeJSON(writer, http.StatusOK, config)
	default:
		methodNotAllowed(writer, request, http.MethodGet, http.MethodPut)
	}
}

// handleRoutingRulesApply accepts the YAML intent document and replaces the
// stored routing rules. The body is the document itself, not a JSON wrapper,
// so a fingerprint-browser profile can post the file it already keeps.
func (s *Server) handleRoutingRulesApply(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		methodNotAllowed(writer, request, http.MethodPost)
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, 64<<10)
	raw, err := io.ReadAll(request.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			s.writeAPIError(writer, request, http.StatusRequestEntityTooLarge, "payload_too_large", "yaml body is larger than 64KiB")
			return
		}
		s.writeAPIError(writer, request, http.StatusBadRequest, "invalid_request", "yaml body could not be read")
		return
	}
	config, err := s.routingRules.ApplyYAML(request.Context(), string(raw))
	if err != nil {
		s.handleError(writer, request, err)
		return
	}
	writeJSON(writer, http.StatusOK, config)
}
