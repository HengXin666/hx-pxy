package api

import (
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
