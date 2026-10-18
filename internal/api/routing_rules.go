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
		var body routingRulesPut
		if err := decodeJSONBody(writer, request, &body); err != nil {
			s.writeAPIError(writer, request, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}
		config := routingrules.Config{RuleSets: body.RuleSets}
		if body.Default != nil || body.AppliesTo != nil {
			config.Default = stringOrEmpty(body.Default)
			if body.AppliesTo != nil {
				config.AppliesTo = *body.AppliesTo
			}
		}
		if body.Default == nil || body.AppliesTo == nil {
			current, err := s.routingRules.Get(request.Context())
			if err != nil {
				s.handleError(writer, request, err)
				return
			}
			if body.Default == nil {
				config.Default = current.Default
			}
			if body.AppliesTo == nil {
				config.AppliesTo = current.AppliesTo
			}
		}
		updated, err := s.routingRules.Update(request.Context(), config)
		if err != nil {
			s.handleError(writer, request, err)
			return
		}
		writeJSON(writer, http.StatusOK, updated)
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

// routingRulesPut distinguishes a missing default from an explicit empty one.
// The rules UI sends rule_sets only; wiping Default on that save would put
// browser inbounds back on the legacy proxy binding.
type routingRulesPut struct {
	Default   *string                `json:"default"`
	AppliesTo *[]string              `json:"applies_to"`
	RuleSets  []routingrules.RuleSet `json:"rule_sets"`
}

func stringOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
