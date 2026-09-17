// Package quickstart builds a complete, working proxy in one call.
//
// The ordinary flow needs four calls before anything carries traffic —
// register a subscription, refresh it, create a group, publish a listener —
// and a listener that references an empty group silently carries nothing. This
// package orders those steps for a caller that just wants a usable endpoint,
// and keeps the all-or-nothing behaviour of the individual services: if a later
// step fails, the rows this call created are removed again.
package quickstart

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/HengXin666/HX-ProxyGroup/internal/listener"
	"github.com/HengXin666/HX-ProxyGroup/internal/proxygroup"
	"github.com/HengXin666/HX-ProxyGroup/internal/proxyservice"
	"github.com/HengXin666/HX-ProxyGroup/internal/subscription"
)

var (
	// ErrInvalid marks a request the caller can fix.
	ErrInvalid = errors.New("invalid quick start request")
	// ErrCreateFailed marks a failure after the request was accepted. The rows
	// created by this call are rolled back before it is returned.
	ErrCreateFailed = errors.New("quick start failed")
)

// defaultPort is used when the caller omits a port. It matches the conventional
// Mixed port, and in shared mode it is replaced by the aggregate entry point
// anyway, so the value only matters for a per-port installation.
const defaultPort = 7890

// SubscriptionService is the subset of the subscription application service this
// orchestration needs.
type SubscriptionService interface {
	Create(context.Context, subscription.CreateRequest) (subscription.Subscription, error)
	Refresh(context.Context, string) (subscription.RefreshResult, error)
	Delete(context.Context, string, int) error
}

// ProxyServiceService creates the group and its listener together.
type ProxyServiceService interface {
	Create(context.Context, proxyservice.CreateRequest) (proxyservice.ServiceRecord, error)
}

// Request is the one-call description of a proxy the caller wants to exist.
type Request struct {
	// Name of the resulting group and listener.
	Name string `json:"name"`
	// SubscriptionURL registers and refreshes a remote subscription inline.
	SubscriptionURL string `json:"subscription_url,omitempty"`
	// SubscriptionName names the subscription created from SubscriptionURL.
	SubscriptionName string `json:"subscription_name,omitempty"`
	// SubscriptionIDs reuses subscriptions that already exist and are already
	// refreshed. Use these when the nodes are known to be present.
	SubscriptionIDs []string `json:"subscription_ids,omitempty"`
	// NodeIDs selects explicit nodes instead of a subscription.
	NodeIDs []string `json:"node_ids,omitempty"`

	Strategy string `json:"strategy,omitempty"`
	// Limit caps how many members the group keeps. 0 keeps every match.
	Limit int `json:"limit,omitempty"`

	Kind        string         `json:"kind,omitempty"`
	BindAddress string         `json:"bind_address,omitempty"`
	Port        int            `json:"port,omitempty"`
	Auth        *listener.Auth `json:"auth,omitempty"`
	// PublicEndpoint is required when a reverse proxy fronts a loopback bind.
	PublicEndpoint listener.PublicEndpoint `json:"public_endpoint,omitempty"`
	Transport      listener.Transport      `json:"transport,omitempty"`
}

// Result reports what now exists and how a consumer reaches it.
type Result struct {
	Group    any `json:"group"`
	Listener any `json:"listener"`
	// SharePath is the subscription URL path for a proxy client.
	SharePath string `json:"share_path"`
	// ConsumerNodesPath is the frozen JSON node listing for a program that dials
	// the nodes itself. It is the same token as SharePath.
	ConsumerNodesPath string `json:"consumer_nodes_path"`
	// Subscription is the subscription created by this call, when it created one.
	Subscription *subscription.Subscription `json:"subscription,omitempty"`
	// Refresh is the snapshot produced by this call, when it refreshed one.
	Refresh *subscription.RefreshResult `json:"refresh,omitempty"`
	// EstimatedNodes is how many nodes the source reported. Zero means the group
	// may carry nothing until the next successful refresh.
	EstimatedNodes int `json:"estimated_nodes"`
	// Auth is the credential the published service now requires. It is returned
	// because this call may have generated it; a caller that supplied its own
	// gets that back.
	Auth *listener.Auth `json:"auth,omitempty"`
	// Workflow echoes the ordered steps that were taken, so a caller can repeat
	// or audit the path.
	Workflow []string `json:"workflow"`
}

// Service orchestrates subscription, group and listener creation.
type Service struct {
	subscriptions SubscriptionService
	services      ProxyServiceService
}

func NewService(subscriptions SubscriptionService, services ProxyServiceService) (*Service, error) {
	if subscriptions == nil || services == nil {
		return nil, errors.New("quick start requires the subscription and proxy service applications")
	}
	return &Service{subscriptions: subscriptions, services: services}, nil
}

// Create reaches a published proxy, creating and refreshing the source first
// when the caller supplied one. Every failure removes whatever this call
// created, so a returned error never leaves a half-built service behind.
func (s *Service) Create(ctx context.Context, request Request) (result Result, resultErr error) {
	request.Name = strings.TrimSpace(request.Name)
	if request.Name == "" {
		return Result{}, fmt.Errorf("%w: name is required", ErrInvalid)
	}
	request.SubscriptionURL = strings.TrimSpace(request.SubscriptionURL)
	hasSource := request.SubscriptionURL != "" || len(request.SubscriptionIDs) > 0 || len(request.NodeIDs) > 0
	if !hasSource {
		return Result{}, fmt.Errorf("%w: provide subscription_url, subscription_ids, or node_ids", ErrInvalid)
	}
	if request.SubscriptionURL != "" && len(request.SubscriptionIDs) > 0 {
		return Result{}, fmt.Errorf("%w: subscription_url and subscription_ids are mutually exclusive", ErrInvalid)
	}
	if strings.TrimSpace(request.Kind) == "" {
		request.Kind = "mixed"
	}
	if strings.TrimSpace(request.BindAddress) == "" {
		// Loopback by default: reaching a service from outside must be an
		// explicit decision, and the reverse proxy dials it locally.
		request.BindAddress = "127.0.0.1"
	}
	if request.Port == 0 {
		request.Port = defaultPort
	}
	// The shared inbound (the default mode) routes members by username, so a
	// member without credentials is rejected. Generating them here is what makes
	// this genuinely one call: the caller gets a usable credential instead of an
	// error telling it to supply one.
	if request.Auth == nil || strings.TrimSpace(request.Auth.Username) == "" || request.Auth.Password == "" {
		generated, err := generateAuth(request.Kind)
		if err != nil {
			return Result{}, fmt.Errorf("%w: %v", ErrCreateFailed, err)
		}
		request.Auth = generated
	}

	workflow := make([]string, 0, 4)
	var createdSubscription *subscription.Subscription
	// Roll back the subscription this call created if any later step fails. The
	// proxy service already rolls back its own group when its listener fails.
	defer func() {
		if resultErr == nil || createdSubscription == nil {
			return
		}
		_ = s.subscriptions.Delete(ctx, createdSubscription.ID, createdSubscription.Version)
	}()

	sourceSpec := subscriptionSource{
		subscriptionIDs: request.SubscriptionIDs,
		nodeIDs:         request.NodeIDs,
		limit:           request.Limit,
	}
	if request.SubscriptionURL != "" {
		name := strings.TrimSpace(request.SubscriptionName)
		if name == "" {
			name = request.Name
		}
		created, err := s.subscriptions.Create(ctx, subscription.CreateRequest{
			Name:         name,
			SourceType:   subscription.SourceRemote,
			SourceConfig: subscription.SourceConfig{URL: request.SubscriptionURL},
		})
		if err != nil {
			return Result{}, fmt.Errorf("%w: create subscription: %v", ErrCreateFailed, err)
		}
		createdSubscription = &created
		workflow = append(workflow, "created subscription "+created.ID)

		// Refresh before the group exists: a group that selects from an
		// unrefreshed subscription matches no node and would publish an empty
		// service that accepts connections and routes nothing.
		refresh, err := s.subscriptions.Refresh(ctx, created.ID)
		if err != nil {
			return Result{}, fmt.Errorf("%w: refresh subscription: %v", ErrCreateFailed, err)
		}
		workflow = append(workflow, fmt.Sprintf("refreshed subscription, %d node(s) detected", refresh.EstimatedNodes))
		result.Refresh = &refresh
		result.EstimatedNodes = refresh.EstimatedNodes
		sourceSpec.subscriptionIDs = []string{created.ID}
	}

	record, err := s.services.Create(ctx, proxyservice.CreateRequest{
		Name:       request.Name,
		Strategy:   request.Strategy,
		SourceSpec: proxyGroupSourceSpec(sourceSpec),
		Listener: proxyservice.ListenerCreateRequest{
			Name:           request.Name,
			Kind:           request.Kind,
			BindAddress:    request.BindAddress,
			Port:           request.Port,
			Auth:           request.Auth,
			Transport:      request.Transport,
			PublicEndpoint: request.PublicEndpoint,
		},
	})
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrCreateFailed, err)
	}
	workflow = append(workflow, "created proxy group "+record.Group.ID, "published listener "+record.Listener.ID)

	result.Group = record.Group
	result.Listener = record.Listener
	result.Subscription = createdSubscription
	result.Auth = request.Auth
	result.Workflow = workflow
	result.SharePath = record.Listener.SharePath
	if token := strings.TrimPrefix(record.Listener.SharePath, "/sub/"); token != "" && token != record.Listener.SharePath {
		result.ConsumerNodesPath = listener.ConsumerNodesPath + token
	}
	return result, nil
}

// generateAuth mints the credential a published listener needs. The username is
// the member selector inside the shared inbound, so it must be unique per
// service; vless and vmess additionally require a UUID password because the
// data plane uses it as the client id.
func generateAuth(kind string) (*listener.Auth, error) {
	username, err := randomHex(8)
	if err != nil {
		return nil, err
	}
	password, err := randomHex(16)
	if err != nil {
		return nil, err
	}
	if kind == "vless" || kind == "vmess" {
		password, err = randomUUID()
		if err != nil {
			return nil, err
		}
	}
	return &listener.Auth{Username: "svc-" + username, Password: password}, nil
}

func randomHex(bytes int) (string, error) {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate credential: %w", err)
	}
	return hex.EncodeToString(buffer), nil
}

// randomUUID renders a version-4 UUID, which is the client id format the data
// plane requires for vless and vmess.
func randomUUID() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate uuid: %w", err)
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buffer[0:4], buffer[4:6], buffer[6:8], buffer[8:10], buffer[10:16]), nil
}

// subscriptionSource is the resolved member selection, kept local so the
// request type stays flat and easy for a caller to write.
type subscriptionSource struct {
	subscriptionIDs []string
	nodeIDs         []string
	limit           int
}

func proxyGroupSourceSpec(source subscriptionSource) proxygroup.SourceSpec {
	spec := proxygroup.SourceSpec{
		SubscriptionIDs: source.subscriptionIDs,
		NodeIDs:         source.nodeIDs,
		Limit:           source.limit,
	}
	// A subscription-backed group is interval-tested and ordered by latency; a
	// test URL is filled in by the group service when the strategy needs one.
	if len(source.subscriptionIDs) > 0 {
		spec.SortBy = "latency"
	}
	if len(source.subscriptionIDs) == 0 && len(source.nodeIDs) == 0 {
		spec.AllowEmpty = true
	}
	return spec
}
