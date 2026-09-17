package main

import (
	"os"
	"path/filepath"
	"testing"
)

// documentBody is any non-empty file: resolvedSourceRoot only cares that the
// path exists as a regular file, not what the document says.
const documentBody = "doc"

// resolvedSourceRoot decides whether the About page may advertise a local path
// for the AI-facing documents. Advertising one that is not there would send the
// administrator's AI to a missing file, so the probe must be strict: an empty or
// partial checkout resolves to "", never to a best-effort guess.
func TestResolvedSourceRootRequiresTheAgentFacingMaterial(t *testing.T) {
	t.Parallel()

	complete := t.TempDir()
	for _, relative := range []string{
		filepath.Join(".agents", "skills", "hx-consumer-api", "SKILL.md"),
		filepath.Join("docs", "RESIDENTIAL_AI_QUICKSTART.md"),
	} {
		if err := writeDocument(filepath.Join(complete, relative)); err != nil {
			t.Fatalf("write %s: %v", relative, err)
		}
	}

	if got := resolvedSourceRoot(complete); got != complete {
		t.Fatalf("complete checkout should resolve to itself: got %q want %q", got, complete)
	}

	// A release bundle ships web/ and the binaries only. Pointing at an empty
	// directory must not produce a local path.
	if got := resolvedSourceRoot(t.TempDir()); got != "" {
		t.Fatalf("a checkout without the skills must resolve to empty: got %q", got)
	}

	// Exactly one of the two probes present is still not enough: the consumer
	// skill and the residential guide are different scenarios, so a path that
	// satisfies only one of them hands half the readers a dead link.
	partial := t.TempDir()
	consumer := filepath.Join(partial, ".agents", "skills", "hx-consumer-api", "SKILL.md")
	if err := writeDocument(consumer); err != nil {
		t.Fatalf("write partial skill: %v", err)
	}
	if got := resolvedSourceRoot(partial); got != "" {
		t.Fatalf("a checkout missing the residential guide must resolve to empty: got %q", got)
	}

	if got := resolvedSourceRoot("   "); got != "" {
		t.Fatalf("blank configuration must resolve to empty: got %q", got)
	}
}

// A directory sitting where a file is expected must not count: otherwise a
// stray folder masquerades as the document the AI would fetch.
func TestResolvedSourceRootRejectsDirectories(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	decoy := filepath.Join(root, ".agents", "skills", "hx-consumer-api", "SKILL.md")
	if err := os.MkdirAll(decoy, 0o755); err != nil {
		t.Fatalf("create decoy skill directory: %v", err)
	}
	if err := writeDocument(filepath.Join(root, "docs", "RESIDENTIAL_AI_QUICKSTART.md")); err != nil {
		t.Fatalf("write guide: %v", err)
	}

	if got := resolvedSourceRoot(root); got != "" {
		t.Fatalf("a directory where the skill file belongs must resolve to empty: got %q", got)
	}
}

func writeDocument(absolute string) error {
	if err := os.MkdirAll(filepath.Dir(absolute), 0o755); err != nil {
		return err
	}
	return os.WriteFile(absolute, []byte(documentBody), 0o644)
}
