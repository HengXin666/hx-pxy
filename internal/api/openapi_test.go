package api

import (
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/HengXin666/hx-pxy/internal/listener"
	"github.com/HengXin666/hx-pxy/internal/residential"
)

// The OpenAPI documents under docs/openapi are a contract, so they are checked
// against the Go types that render the responses: a field added, renamed or
// dropped on one side without the other fails here. The two documents also
// stay disjoint: subscription services and residential channels are separate
// resources and must never share an operation.

type openAPIDocument struct {
	Paths         map[string]map[string]any `yaml:"paths"`
	RawComponents struct {
		Schemas map[string]openAPISchema `yaml:"schemas"`
	} `yaml:"components"`
}

type openAPISchema struct {
	Properties map[string]any `yaml:"properties"`
}

func loadOpenAPI(t *testing.T, name string) openAPIDocument {
	t.Helper()
	raw, err := os.ReadFile("../../docs/openapi/" + name)
	if err != nil {
		t.Fatal(err)
	}
	var document openAPIDocument
	if err := yaml.Unmarshal(raw, &document); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return document
}

func jsonFields(value any) []string {
	typ := reflect.TypeOf(value)
	fields := make([]string, 0, typ.NumField())
	for index := 0; index < typ.NumField(); index++ {
		tag := strings.Split(typ.Field(index).Tag.Get("json"), ",")[0]
		if tag != "" && tag != "-" {
			fields = append(fields, tag)
		}
	}
	sort.Strings(fields)
	return fields
}

func schemaFields(t *testing.T, document openAPIDocument, name string) []string {
	t.Helper()
	schema, ok := document.RawComponents.Schemas[name]
	if !ok {
		t.Fatalf("schema %s missing", name)
	}
	fields := make([]string, 0, len(schema.Properties))
	for field := range schema.Properties {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	return fields
}

func TestOpenAPIDocumentsMatchResponseTypes(t *testing.T) {
	consumer := loadOpenAPI(t, "subscription-consumer.openapi.yaml")
	control := loadOpenAPI(t, "residential-control.openapi.yaml")
	cases := []struct {
		document openAPIDocument
		schema   string
		value    any
	}{
		{consumer, "ServiceNode", listener.ConsumerNode{}},
		{consumer, "ServiceNodes", listener.ConsumerPayload{}},
		{control, "ChannelNode", residential.ControlNode{}},
		{control, "ChannelNodes", residential.ControlNodeList{}},
	}
	for _, item := range cases {
		if got, want := schemaFields(t, item.document, item.schema), jsonFields(item.value); !reflect.DeepEqual(got, want) {
			t.Errorf("%s properties = %v, Go type renders %v", item.schema, got, want)
		}
	}
}

func TestOpenAPIKeepsSubscriptionAndResidentialSurfacesApart(t *testing.T) {
	consumer := loadOpenAPI(t, "subscription-consumer.openapi.yaml")
	control := loadOpenAPI(t, "residential-control.openapi.yaml")
	for path := range consumer.Paths {
		if strings.HasPrefix(path, "/ctl/") || strings.HasPrefix(path, "/rot/") {
			t.Errorf("subscription document exposes residential path %s", path)
		}
	}
	for path := range control.Paths {
		if !strings.HasPrefix(path, "/ctl/") {
			t.Errorf("residential document exposes non-control path %s", path)
		}
	}
	if len(consumer.Paths) == 0 || len(control.Paths) == 0 {
		t.Fatal("documents must not be empty")
	}
}
