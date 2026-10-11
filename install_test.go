package hxpxy

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallScriptSyntax(t *testing.T) {
	t.Parallel()
	command := exec.Command("bash", "-n", "install.sh")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("bash -n install.sh failed: %v\n%s", err, output)
	}
}

func TestSystemdUnitKeepsManagementAPIPrivate(t *testing.T) {
	t.Parallel()
	content, err := os.ReadFile("deploy/systemd/hx-pxy.service")
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	unit := string(content)
	required := []string{
		"--listen 127.0.0.1:19090",
		"--master-key /var/lib/hx-pxy/master.key",
		"--web-root /usr/local/lib/hx-pxy/current/web",
		"--mihomo-external",
		"Requires=hx-pxy-dataplane.service hx-pxy-terminal.service",
		"After=network-online.target hx-pxy-dataplane.service hx-pxy-terminal.service",
		"--terminal-socket /run/hx-pxy/terminal.sock",
		"Restart=on-failure",
		"NoNewPrivileges=true",
		"ProtectSystem=strict",
		"ProtectHome=true",
		"ReadWritePaths=/var/lib/hx-pxy",
	}
	for _, expected := range required {
		if !strings.Contains(unit, expected) {
			t.Errorf("systemd unit is missing %q", expected)
		}
	}
}

func TestPrivilegedTerminalSystemdUnitIsRootOnlyAndSocketScoped(t *testing.T) {
	t.Parallel()
	content, err := os.ReadFile("deploy/systemd/hx-pxy-terminal.service")
	if err != nil {
		t.Fatal(err)
	}
	unit := string(content)
	for _, expected := range []string{
		"User=root",
		"--terminal-helper",
		"--terminal-socket /run/hx-pxy/terminal.sock",
		"--terminal-socket-group hx-pxy",
		"--terminal-helper-user hx-pxy",
		"RuntimeDirectoryMode=0750",
	} {
		if !strings.Contains(unit, expected) {
			t.Errorf("privileged terminal unit is missing %q", expected)
		}
	}
	if strings.Contains(unit, "ListenStream=") {
		t.Fatal("privileged terminal must not expose a network socket")
	}
}

func TestDataPlaneSystemdUnitIsIndependentAndSandboxed(t *testing.T) {
	t.Parallel()
	content, err := os.ReadFile("deploy/systemd/hx-pxy-dataplane.service")
	if err != nil {
		t.Fatal(err)
	}
	unit := string(content)
	required := []string{
		"/usr/local/lib/hx-pxy/current/mihomo",
		"/var/lib/hx-pxy/runtime/active.yaml",
		"Restart=on-failure",
		"StartLimitBurst=20",
		"NoNewPrivileges=true",
		"ProtectSystem=strict",
		"ReadWritePaths=/var/lib/hx-pxy/runtime",
	}
	for _, expected := range required {
		if !strings.Contains(unit, expected) {
			t.Errorf("data-plane unit is missing %q", expected)
		}
	}
	if strings.Contains(unit, "User=root") {
		t.Fatal("data-plane unit must not run as root")
	}
}

func TestInstallScriptDocumentsVerifiedReleaseAndOneLineUpgrade(t *testing.T) {
	t.Parallel()
	content, err := os.ReadFile("install.sh")
	if err != nil {
		t.Fatal(err)
	}
	script := string(content)
	for _, expected := range []string{"SHA256SUMS", "verify_bundle", "safe_extract_bundle", "switch_current", "sudo hx-pxy-install upgrade", "hx-pxy-dataplane.service", "hx-pxy-terminal.service"} {
		if !strings.Contains(script, expected) {
			t.Errorf("install script is missing %q", expected)
		}
	}
}

func TestInstallScriptRejectsUnsafeOfflineVersion(t *testing.T) {
	t.Parallel()
	command := exec.Command("bash", "-c", `source ./install.sh; VERSION='../../etc'; validate_version`)
	if output, err := command.CombinedOutput(); err == nil {
		t.Fatalf("unsafe version was accepted: %s", output)
	}
}

func TestPackageReleaseBundleContract(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	control := writeExecutable(t, root, "hx-pxyd")
	mihomo := writeExecutable(t, root, "mihomo")
	web := filepath.Join(root, "web")
	if err := os.Mkdir(web, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(web, "index.html"), []byte("release-ui\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	outputs := []string{filepath.Join(root, "out-a"), filepath.Join(root, "out-b")}
	var digests [2][sha256.Size]byte
	for index, output := range outputs {
		for run := 0; run < 2; run++ {
			command := exec.Command("bash", "scripts/package-release.sh",
				"--version", "v1.2.3", "--arch", "amd64",
				"--control", control, "--mihomo", mihomo,
				"--web-dir", web, "--output-dir", output,
			)
			if combined, err := command.CombinedOutput(); err != nil {
				t.Fatalf("package release: %v\n%s", err, combined)
			}
		}
		bundle := filepath.Join(output, "hx-pxy_v1.2.3_linux_amd64.tar.gz")
		payload, err := os.ReadFile(bundle)
		if err != nil {
			t.Fatal(err)
		}
		digests[index] = sha256.Sum256(payload)
		assertReleaseArchive(t, bundle)
		checksums, err := os.ReadFile(filepath.Join(output, "SHA256SUMS"))
		if err != nil {
			t.Fatal(err)
		}
		expectedLine := fmt.Sprintf("%x  %s", digests[index], filepath.Base(bundle))
		if strings.TrimSpace(string(checksums)) != expectedLine {
			t.Fatalf("SHA256SUMS = %q, want %q", strings.TrimSpace(string(checksums)), expectedLine)
		}
		version, err := os.ReadFile(filepath.Join(output, "VERSION"))
		if err != nil || string(version) != "v1.2.3\n" {
			t.Fatalf("VERSION = %q, err=%v", version, err)
		}
	}
	if digests[0] != digests[1] {
		t.Fatalf("release archives are not reproducible: %x != %x", digests[0], digests[1])
	}
}

func writeExecutable(t *testing.T, root, name string) string {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func assertReleaseArchive(t *testing.T, path string) {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer compressed.Close()
	wanted := map[string]bool{
		"./bin/hx-pxyd":                   false,
		"./bin/mihomo":                    false,
		"./LICENSE":                       false,
		"./web/index.html":                false,
		"./install.sh":                    false,
		"./deploy/systemd/hx-pxy.service": false,
		"./deploy/systemd/hx-pxy-dataplane.service": false,
		"./deploy/systemd/hx-pxy-terminal.service":  false,
	}
	reader := tar.NewReader(compressed)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := wanted[header.Name]; ok {
			wanted[header.Name] = true
		}
	}
	for name, found := range wanted {
		if !found {
			t.Errorf("release archive is missing %s", name)
		}
	}
}
