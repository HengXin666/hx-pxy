package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/HengXin666/hx-pxy/internal/proxyservice"
)

// recordingProxyServices captures the request the handler finally hands to the
// application service, so a test can assert on the contract rather than on the
// response body alone.
type recordingProxyServices struct {
	requests []proxyservice.UpdateRequest
}

func (service *recordingProxyServices) Create(context.Context, proxyservice.CreateRequest) (proxyservice.ServiceRecord, error) {
	return proxyservice.ServiceRecord{}, nil
}

func (service *recordingProxyServices) Update(_ context.Context, request proxyservice.UpdateRequest) (proxyservice.ServiceRecord, error) {
	service.requests = append(service.requests, request)
	return proxyservice.ServiceRecord{}, nil
}

func newProxyServiceServer(t *testing.T, service ProxyServiceService) string {
	t.Helper()
	server, err := NewServer(&stubBundleService{}, slog.New(slog.NewTextHandler(io.Discard, nil)), WithProxyServices(service))
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	testServer := httptest.NewServer(server.Handler())
	t.Cleanup(testServer.Close)
	return testServer.URL
}

func putProxyService(t *testing.T, endpoint, body string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodPut, endpoint, strings.NewReader(body))
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("PUT %s error = %v", endpoint, err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	return response
}

func errorCode(t *testing.T, response *http.Response) string {
	t.Helper()
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return payload.Error.Code
}

// TestUpdateProxyServiceAddressIsAuthoritative pins the fix for an id that was
// parsed and then dropped: PUT /proxy-services/<id> used to edit whatever
// group_id the body named, so any session could write to any service by
// addressing a different one.
func TestUpdateProxyServiceAddressIsAuthoritative(t *testing.T) {
	service := &recordingProxyServices{}
	endpoint := newProxyServiceServer(t, service) + "/api/v1/proxy-services/group-addressed"

	response := putProxyService(t, endpoint, `{"group_version":1,"listener_id":"listener-1","listener_version":1}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusOK)
	}
	if len(service.requests) != 1 {
		t.Fatalf("update calls = %d, want 1", len(service.requests))
	}
	if got := service.requests[0].GroupID; got != "group-addressed" {
		t.Fatalf("group id = %q, want the addressed id %q", got, "group-addressed")
	}
}

func TestUpdateProxyServiceRejectsContradictingBody(t *testing.T) {
	service := &recordingProxyServices{}
	endpoint := newProxyServiceServer(t, service) + "/api/v1/proxy-services/group-addressed"

	response := putProxyService(t, endpoint, `{"group_id":"group-other","group_version":1,"listener_id":"listener-1","listener_version":1}`)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusBadRequest)
	}
	if code := errorCode(t, response); code != "invalid_request" {
		t.Fatalf("error code = %q, want %q", code, "invalid_request")
	}
	if len(service.requests) != 0 {
		t.Fatalf("update calls = %d, want 0", len(service.requests))
	}
}

// TestUpdateProxyServiceRejectsEmptyBody is the regression guard for the
// original symptom: a request whose body never arrived decoded into a
// zero-valued request and was answered with 404, which blamed a missing
// resource for a malformed request.
func TestUpdateProxyServiceRejectsEmptyBody(t *testing.T) {
	service := &recordingProxyServices{}
	endpoint := newProxyServiceServer(t, service) + "/api/v1/proxy-services/group-addressed"

	for _, body := range []string{"", "{}", `{"group_version":1}`, `{"listener_id":"listener-1"}`} {
		response := putProxyService(t, endpoint, body)
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("body %q: status = %d, want %d", body, response.StatusCode, http.StatusBadRequest)
		}
	}
	if len(service.requests) != 0 {
		t.Fatalf("update calls = %d, want 0", len(service.requests))
	}
}
