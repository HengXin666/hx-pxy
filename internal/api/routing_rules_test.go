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

	"github.com/HengXin666/hx-pxy/internal/routingrules"
)

type fakeRoutingRulesService struct {
	config  routingrules.Config
	applied string
}

func (service *fakeRoutingRulesService) Get(context.Context) (routingrules.Config, error) {
	return service.config, nil
}
func (service *fakeRoutingRulesService) Update(_ context.Context, config routingrules.Config) (routingrules.Config, error) {
	service.config = config
	return config, nil
}
func (service *fakeRoutingRulesService) ApplyYAML(_ context.Context, raw string) (routingrules.Config, error) {
	service.applied = raw
	service.config = routingrules.Config{RuleSets: []routingrules.RuleSet{{ID: "yaml-01", Name: "from-yaml", Enabled: true}}}
	return service.config, nil
}

func TestRoutingRulesAPIUpdatesWholeDesiredState(t *testing.T) {
	service := &fakeRoutingRulesService{}
	server, err := NewServer(&stubBundleService{}, slog.New(slog.NewTextHandler(io.Discard, nil)), WithRoutingRules(service))
	if err != nil {
		t.Fatal(err)
	}
	config := routingrules.Config{RuleSets: []routingrules.RuleSet{{ID: "ads", Name: "Ads", Enabled: true, Action: routingrules.Action{Type: "reject"}, Rules: []routingrules.Rule{{Type: "domain_suffix", Value: "ads.example"}}}}}
	payload, _ := json.Marshal(config)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/api/v1/routing-rules", strings.NewReader(string(payload)))
	request.Header.Set("Content-Type", "application/json")
	server.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || len(service.config.RuleSets) != 1 {
		t.Fatalf("status = %d, config = %+v", recorder.Code, service.config)
	}
}

func TestRoutingRulesApplyPostsYAMLBody(t *testing.T) {
	service := &fakeRoutingRulesService{}
	server, err := NewServer(&stubBundleService{}, slog.New(slog.NewTextHandler(io.Discard, nil)), WithRoutingRules(service))
	if err != nil {
		t.Fatal(err)
	}
	body := "version: 1\nname: env\ndefault: proxy\nrules: []\n"
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/routing-rules/apply", strings.NewReader(body))
	server.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || service.applied != body || service.config.RuleSets[0].ID != "yaml-01" {
		t.Fatalf("status = %d, applied = %q, config = %+v", recorder.Code, service.applied, service.config)
	}
}
