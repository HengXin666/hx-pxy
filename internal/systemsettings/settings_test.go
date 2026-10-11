package systemsettings

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/HengXin666/hx-pxy/internal/store"
)

type memoryRepository struct {
	values map[string]string
}

func (repository *memoryRepository) GetMetadata(_ context.Context, key string) (string, error) {
	value := repository.values[key]
	if value == "" {
		return "", store.ErrNotFound
	}
	return value, nil
}

func (repository *memoryRepository) SetMetadata(_ context.Context, key, value string) error {
	if repository.values == nil {
		repository.values = make(map[string]string)
	}
	repository.values[key] = value
	return nil
}

func TestSettingsLoadLegacyQualityConfiguration(t *testing.T) {
	repository := &memoryRepository{values: map[string]string{legacyQualityKey: `{"check_interval_seconds":120,"timeout_seconds":4,"batch_size":10,"test_url":"https://example.com/"}`}}
	settings, err := Load(context.Background(), repository)
	if err != nil {
		t.Fatal(err)
	}
	if settings.Quality.CheckIntervalSeconds != 120 || settings.Quality.ProbeConcurrency != 4 || len(settings.Quality.HealthTargets) != 5 {
		t.Fatalf("migrated settings = %+v", settings.Quality)
	}
}

func TestSettingsLoadMigratesOriginalProbeDefaults(t *testing.T) {
	legacy := Default()
	legacy.Quality.TestURL = legacyTestURL
	legacy.Quality.TimeoutSeconds = 8
	encoded, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	repository := &memoryRepository{values: map[string]string{MetadataKey: string(encoded)}}

	settings, err := Load(context.Background(), repository)
	if err != nil {
		t.Fatal(err)
	}
	if settings.Quality.TestURL != defaultTestURL || settings.Quality.TimeoutSeconds != 10 {
		t.Fatalf("quality settings = %+v", settings.Quality)
	}
}

type fakeApplier struct {
	err   error
	calls int
}

func (applier *fakeApplier) Apply(context.Context) error {
	applier.calls++
	return applier.err
}

func TestSettingsPersistAndApply(t *testing.T) {
	repository := &memoryRepository{}
	applier := &fakeApplier{}
	service, err := NewService(repository, applier)
	if err != nil {
		t.Fatal(err)
	}
	settings := Default()
	settings.DNS.IPv6 = true
	settings.Quality.HealthTargets[0].Enabled = true
	updated, err := service.Update(context.Background(), settings)
	if err != nil {
		t.Fatal(err)
	}
	if !updated.DNS.IPv6 || !updated.Quality.HealthTargets[0].Enabled || applier.calls != 1 {
		t.Fatalf("updated = %+v, apply calls = %d", updated, applier.calls)
	}
	reloaded, err := service.Get(context.Background())
	if err != nil || !reloaded.DNS.IPv6 {
		t.Fatalf("reloaded = %+v, error = %v", reloaded, err)
	}
}

func TestSettingsRollbackWhenApplyFails(t *testing.T) {
	repository := &memoryRepository{}
	previous := Default()
	if err := Save(context.Background(), repository, previous); err != nil {
		t.Fatal(err)
	}
	applier := &fakeApplier{err: errors.New("invalid candidate")}
	service, _ := NewService(repository, applier)
	next := previous
	next.Performance.LogLevel = "debug"
	if _, err := service.Update(context.Background(), next); err == nil {
		t.Fatal("expected apply failure")
	}
	reloaded, err := Load(context.Background(), repository)
	if err != nil || reloaded.Performance.LogLevel != previous.Performance.LogLevel {
		t.Fatalf("rollback settings = %+v, error = %v", reloaded, err)
	}
	if applier.calls != 2 {
		t.Fatalf("apply calls = %d, want apply and rollback", applier.calls)
	}
}

func TestSettingsRejectPrivateProbeTarget(t *testing.T) {
	settings := Default()
	settings.Quality.HealthTargets = []HealthTarget{{ID: "metadata", Name: "metadata", URL: "http://169.254.169.254/latest", Enabled: true}}
	if err := Validate(settings); !errors.Is(err, ErrInvalid) {
		t.Fatalf("error = %v, want ErrInvalid", err)
	}
}
