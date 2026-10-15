package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/HengXin666/hx-pxy/internal/dockeraccess"
	"github.com/HengXin666/hx-pxy/internal/listener"
)

type stubDockerAccess struct {
	applied dockeraccess.ApplyRequest
	revoked string
}

func (s *stubDockerAccess) Assess(_ context.Context, id, gateway string) (dockeraccess.Assessment, error) {
	if id == "missing" {
		return dockeraccess.Assessment{}, listener.ErrNotFound
	}
	return dockeraccess.Assessment{ListenerID: id, State: dockeraccess.StateNeedsEntry, Gateway: gateway, Plan: &dockeraccess.Plan{ID: "plan-1"}}, nil
}

func (s *stubDockerAccess) Apply(_ context.Context, id string, request dockeraccess.ApplyRequest) (dockeraccess.Assessment, error) {
	s.applied = request
	if request.PlanID != "plan-1" {
		return dockeraccess.Assessment{}, fmt.Errorf("%w: stale", listener.ErrConflict)
	}
	return dockeraccess.Assessment{ListenerID: id, State: dockeraccess.StateReady}, nil
}

func (s *stubDockerAccess) Revoke(_ context.Context, id string) error { s.revoked = id; return nil }

func (s *stubDockerAccess) Links(context.Context) ([]dockeraccess.Link, error) {
	return []dockeraccess.Link{{ListenerID: "svc", EntryListenerID: "entry"}}, nil
}

func TestDockerAccessRoutes(t *testing.T) {
	stub := &stubDockerAccess{}
	server, err := NewServer(&stubBundleService{}, slog.New(slog.NewTextHandler(io.Discard, nil)),
		WithListeners(&consumerNodeService{}), WithDockerAccess(stub))
	if err != nil {
		t.Fatal(err)
	}
	handler := server.Handler()
	call := func(method, path, body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		handler.ServeHTTP(recorder, request)
		return recorder
	}
	response := call(http.MethodGet, "/api/v1/listeners/svc/docker-access?gateway=172.18.0.1", "")
	var assessment dockeraccess.Assessment
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &assessment) != nil || assessment.Gateway != "172.18.0.1" || assessment.Plan.ID != "plan-1" {
		t.Fatalf("GET = %d %s", response.Code, response.Body.String())
	}
	if response := call(http.MethodGet, "/api/v1/listeners/missing/docker-access", ""); response.Code != http.StatusNotFound {
		t.Fatalf("missing listener = %d", response.Code)
	}
	if response := call(http.MethodPost, "/api/v1/listeners/svc/docker-access", `{"plan_id":"old","confirm":true}`); response.Code != http.StatusConflict {
		t.Fatalf("stale plan = %d %s", response.Code, response.Body.String())
	}
	if response := call(http.MethodPost, "/api/v1/listeners/svc/docker-access", `{"plan_id":"plan-1","confirm":true}`); response.Code != http.StatusOK || !stub.applied.Confirm {
		t.Fatalf("apply = %d", response.Code)
	}
	if response := call(http.MethodDelete, "/api/v1/listeners/svc/docker-access", ""); response.Code != http.StatusNoContent || stub.revoked != "svc" {
		t.Fatalf("revoke = %d", response.Code)
	}
	if response := call(http.MethodGet, "/api/v1/docker-access", ""); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"entry_listener_id":"entry"`) {
		t.Fatalf("links = %d %s", response.Code, response.Body.String())
	}
	if response := call(http.MethodPut, "/api/v1/listeners/svc/docker-access", "{}"); response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT = %d", response.Code)
	}
}
