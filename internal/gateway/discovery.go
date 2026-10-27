package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"cloud.google.com/go/modelarmor/apiv1/modelarmorpb"
	"github.com/aws/aws-sdk-go-v2/aws"
	awscredentials "github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/bedrock"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/cloudresourcemanager/v3"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/option"
	locationpb "google.golang.org/genproto/googleapis/cloud/location"
	"google.golang.org/protobuf/encoding/protojson"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/scope"
	api "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

var (
	guardrailAWSRegion      = regexp.MustCompile(`^[a-z]{2}(?:-[a-z]+)+-[0-9]+$`)
	guardrailAWSIdentifier  = regexp.MustCompile(`^(?:[a-z0-9]+|arn:aws(?:-[a-z]+)?:bedrock:[a-z0-9-]+:[0-9]{12}:guardrail/[a-z0-9]+)$`)
	guardrailGoogleProject  = regexp.MustCompile(`^projects/(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]+)$`)
	guardrailGoogleLocation = regexp.MustCompile(`^projects/(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]+)/locations/[a-z][a-z0-9-]{0,62}$`)
)

// guardrailGoogleCredentialConfiguration contains only fields needed to validate
// the saved credential's type and destinations before invoking Google's parser.
type guardrailGoogleCredentialConfiguration struct {
	Type              google.CredentialsType `json:"type"`
	TokenURI          string                 `json:"token_uri"`
	AuthURI           string                 `json:"auth_uri"`
	UniverseDomain    string                 `json:"universe_domain"`
	ClientEmail       string                 `json:"client_email"`
	PrivateKey        string                 `json:"private_key"`
	ClientID          string                 `json:"client_id"`
	ClientSecret      string                 `json:"client_secret"`
	RefreshToken      string                 `json:"refresh_token"`
	Web               json.RawMessage        `json:"web"`
	Installed         json.RawMessage        `json:"installed"`
	CredentialSource  json.RawMessage        `json:"credential_source"`
	SourceCredentials json.RawMessage        `json:"source_credentials"`
	ImpersonationURL  string                 `json:"service_account_impersonation_url"`
}

// DiscoverGuardrailConnectionResources browses a single page using an authorized
// saved connection. It never accepts credentials or arbitrary provider URLs.
func (s *Service) DiscoverGuardrailConnectionResources(w http.ResponseWriter, r *http.Request, name string, _ gatewayapi.DiscoverGuardrailConnectionResourcesParams) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	access, apiErr := s.resolveResourceAccess(ctx, resourceAccessRequest{
		resource:    "Guardrail Provider",
		workspaceID: r.Header.Get("X-AgentZ-Workspace-ID"),
		operation:   authorization.OperationDiscoverGuardrailConnectionResources,
	})
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	var input gatewayapi.GuardrailResourceDiscoveryInput
	if !decodeJSONBody(w, r, &input, false) {
		return
	}
	if input.Scope != gatewayapi.ResourceScopeOrganisation && input.Scope != gatewayapi.ResourceScopeWorkspace {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_request", "Select the provider scope.", errBadRequest))
		return
	}
	pageSize := 50
	if input.PageSize != nil {
		pageSize = *input.PageSize
	}
	if pageSize < 1 || pageSize > 100 || (input.PageToken != nil && len(*input.PageToken) > 8192) {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(http.StatusBadRequest, "invalid_request", "Invalid resource page size or continuation token.", errBadRequest),
		)
		return
	}
	namespace, err := scope.SelectedNamespace(ctx, s.k8sClient, access.namespace, scope.Selection{
		Scope: api.ResourceScope(input.Scope),
		Kind:  api.OrganizationResourceKindGuardrailConnection,
		Name:  name,
	})
	if err != nil {
		apiutil.WriteError(w, r, resourceForbidden(err))
		return
	}
	connection := &api.GuardrailConnection{}
	err = s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: namespace, Name: name}, connection)
	if err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get guardrail provider", err))
		return
	}
	if !connection.DeletionTimestamp.IsZero() {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusServiceUnavailable, "connection_unavailable",
			"The provider is being deleted.", nil,
		))
		return
	}
	parent := ""
	if input.Parent != nil {
		parent = *input.Parent
	}
	valid := false
	switch connection.Spec.Provider {
	case "Bedrock":
		valid = guardrailAWSRegion.MatchString(connection.Spec.Region) &&
			((input.Kind == gatewayapi.GuardrailResourceDiscoveryInputKindGuardrails && parent == "") ||
				(input.Kind == gatewayapi.GuardrailResourceDiscoveryInputKindVersions && guardrailAWSIdentifier.MatchString(parent)))
	case "ModelArmor":
		valid = (input.Kind == gatewayapi.GuardrailResourceDiscoveryInputKindProjects && parent == "") ||
			(input.Kind == gatewayapi.GuardrailResourceDiscoveryInputKindLocations && guardrailGoogleProject.MatchString(parent)) ||
			(input.Kind == gatewayapi.GuardrailResourceDiscoveryInputKindTemplates && guardrailGoogleLocation.MatchString(parent))
	default:
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(http.StatusBadRequest, "discovery_not_supported", "This service has no selectable cloud guardrail resources.", nil),
		)
		return
	}
	if !valid || len(parent) > 2048 {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest,
			"invalid_request",
			"Select a supported resource kind and canonical parent for this provider.",
			errBadRequest,
		))
		return
	}
	if s.baoKV == nil || connection.Spec.SecretName == "" {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusServiceUnavailable, "credentials_unavailable",
				"Save provider credentials before browsing resources.", nil,
			),
		)
		return
	}
	secret, err := s.baoKV.Get(ctx, connection.CredentialPath())
	if err != nil {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(http.StatusServiceUnavailable, "credentials_unavailable", "Saved provider credentials could not be read.", nil),
		)
		return
	}
	client := *s.outboundHTTP
	client.Timeout = 0
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	result := gatewayapi.GuardrailResourceDiscovery{
		Items: []gatewayapi.GuardrailDiscoveredResource{},
		Kind:  gatewayapi.GuardrailResourceDiscoveryKind(input.Kind),
	}
	switch connection.Spec.Provider {
	case "Bedrock":
		accessKey, _ := secret.Data["accessKey"].(string)
		secretKey, _ := secret.Data["secretKey"].(string)
		sessionToken, _ := secret.Data["sessionToken"].(string)
		if accessKey == "" || secretKey == "" {
			apiutil.WriteError(w, r, apiutil.NewError(
				http.StatusServiceUnavailable,
				"credentials_unavailable",
				"Browsing AWS resources requires a saved access key ID and secret access key.",
				nil,
			))
			return
		}
		bedrockClient := bedrock.NewFromConfig(aws.Config{
			Region:      connection.Spec.Region,
			Credentials: awscredentials.NewStaticCredentialsProvider(accessKey, secretKey, sessionToken),
			HTTPClient:  &client,
			Retryer:     func() aws.Retryer { return aws.NopRetryer{} },
		})
		result.Provider = gatewayapi.GuardrailResourceDiscoveryProviderBedrock
		apiErr = discoverBedrockGuardrailResources(ctx, bedrockClient, input, pageSize, &result)
	case "ModelArmor":
		payload, _ := secret.Data["credentials.json"].(string)
		tokenClient := client
		credentials, err := guardrailGoogleCredentials(ctx, payload, &tokenClient)
		if err != nil {
			apiutil.WriteError(w, r, apiutil.NewError(http.StatusServiceUnavailable, "unsupported_credentials", err.Error(), nil))
			return
		}
		client.Transport = &oauth2.Transport{Source: credentials.TokenSource, Base: client.Transport}
		result.Provider = gatewayapi.GuardrailResourceDiscoveryProviderModelArmor
		apiErr = discoverGoogleGuardrailResources(ctx, &client, input, pageSize, &result)
	}
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	apiutil.WriteJSON(w, http.StatusOK, result)
}

func discoverBedrockGuardrailResources(ctx context.Context, client *bedrock.Client, input gatewayapi.GuardrailResourceDiscoveryInput, pageSize int, result *gatewayapi.GuardrailResourceDiscovery) *apiutil.APIError {
	request := &bedrock.ListGuardrailsInput{
		MaxResults: new(int32(pageSize)),
		NextToken:  input.PageToken,
	}
	if input.Kind == gatewayapi.GuardrailResourceDiscoveryInputKindVersions {
		request.GuardrailIdentifier = input.Parent
	}
	response, err := client.ListGuardrails(ctx, request)
	if err != nil {
		return guardrailDiscoveryError(err)
	}
	for _, item := range response.Guardrails {
		id := aws.ToString(item.Id)
		label := aws.ToString(item.Name)
		if input.Kind == gatewayapi.GuardrailResourceDiscoveryInputKindVersions {
			id = aws.ToString(item.Version)
			label = "Version " + id
			if id == "DRAFT" {
				label = "Working draft (DRAFT)"
			}
		}
		if id == "" || label == "" {
			return apiutil.NewError(
				http.StatusBadGateway, "provider_response_invalid",
				"The provider returned incomplete resource information.", nil,
			)
		}
		result.Items = append(result.Items, gatewayapi.GuardrailDiscoveredResource{
			Id:          id,
			Label:       label,
			Description: item.Description,
		})
	}
	result.NextPageToken = response.NextToken
	return nil
}

func guardrailGoogleCredentials(ctx context.Context, payload string, client *http.Client) (*google.Credentials, error) {
	const unsupported = "resource discovery supports saved Google service account or authorized user JSON with standard Google OAuth endpoints"
	var config guardrailGoogleCredentialConfiguration
	if json.Unmarshal([]byte(payload), &config) != nil {
		return nil, errors.New(unsupported)
	}
	if config.Type != google.ServiceAccount && config.Type != google.AuthorizedUser {
		return nil, errors.New(unsupported)
	}
	validTokenEndpoint := config.TokenURI == "" || config.TokenURI == "https://oauth2.googleapis.com/token"
	validAuthEndpoint := config.AuthURI == "" || config.AuthURI == "https://accounts.google.com/o/oauth2/auth" ||
		config.AuthURI == "https://accounts.google.com/o/oauth2/v2/auth"
	validUniverse := config.UniverseDomain == "" || config.UniverseDomain == "googleapis.com"
	embeddedCredentials := len(config.Web) != 0 || len(config.Installed) != 0 ||
		len(config.CredentialSource) != 0 || len(config.SourceCredentials) != 0 || config.ImpersonationURL != ""
	if !validTokenEndpoint || !validAuthEndpoint || !validUniverse || embeddedCredentials {
		return nil, errors.New(unsupported)
	}
	if config.Type == google.ServiceAccount && (config.ClientEmail == "" || config.PrivateKey == "") {
		return nil, errors.New("saved Google service account credentials are incomplete")
	}
	if config.Type == google.AuthorizedUser && (config.ClientID == "" || config.ClientSecret == "" || config.RefreshToken == "") {
		return nil, errors.New("saved Google authorized user credentials are incomplete")
	}
	ctx = context.WithValue(ctx, oauth2.HTTPClient, client)
	credentials, err := google.CredentialsFromJSONWithType(ctx, []byte(payload), config.Type, "https://www.googleapis.com/auth/cloud-platform")
	if err != nil {
		return nil, errors.New("saved Google credentials could not be loaded")
	}
	return credentials, nil
}

func discoverGoogleProjects(ctx context.Context, client *http.Client, input gatewayapi.GuardrailResourceDiscoveryInput, pageSize int, result *gatewayapi.GuardrailResourceDiscovery) *apiutil.APIError {
	service, err := cloudresourcemanager.NewService(
		ctx, option.WithHTTPClient(client), option.WithEndpoint("https://cloudresourcemanager.googleapis.com/"),
	)
	if err != nil {
		return guardrailDiscoveryError(err)
	}
	request := service.Projects.Search().PageSize(int64(pageSize)).Context(ctx)
	if input.PageToken != nil {
		request.PageToken(*input.PageToken)
	}
	response, err := request.Do()
	if err != nil {
		return guardrailDiscoveryError(err)
	}
	if response == nil {
		return apiutil.NewError(http.StatusBadGateway, "provider_response_invalid", "The provider returned invalid project information.", nil)
	}
	for _, project := range response.Projects {
		if project == nil {
			return apiutil.NewError(http.StatusBadGateway, "provider_response_invalid", "The provider returned invalid project information.", nil)
		}
		if project.State != "ACTIVE" {
			continue
		}
		id := "projects/" + project.ProjectId
		label := project.DisplayName
		if label == "" {
			label = project.ProjectId
		}
		if !guardrailGoogleProject.MatchString(id) {
			return apiutil.NewError(http.StatusBadGateway, "provider_response_invalid", "The provider returned an invalid project identifier.", nil)
		}
		result.Items = append(result.Items, gatewayapi.GuardrailDiscoveredResource{Id: id, Label: label})
	}
	if response.NextPageToken != "" {
		result.NextPageToken = &response.NextPageToken
	}
	return nil
}

func guardrailDiscoveryError(err error) *apiutil.APIError {
	if errors.Is(err, context.DeadlineExceeded) {
		return apiutil.NewError(http.StatusGatewayTimeout, "provider_timeout", "The provider did not respond in time. Try again.", nil)
	}
	code := 0
	var awsHTTP *smithyhttp.ResponseError
	var googleHTTP *googleapi.Error
	var oauthHTTP *oauth2.RetrieveError
	if errors.As(err, &awsHTTP) {
		code = awsHTTP.HTTPStatusCode()
	}
	if errors.As(err, &googleHTTP) {
		code = googleHTTP.Code
	}
	if errors.As(err, &oauthHTTP) && oauthHTTP.Response != nil {
		code = oauthHTTP.Response.StatusCode
		switch oauthHTTP.ErrorCode {
		case "invalid_grant", "invalid_client", "unauthorized_client":
			code = http.StatusUnauthorized
		}
	}
	var providerAPI smithy.APIError
	if errors.As(err, &providerAPI) {
		switch providerAPI.ErrorCode() {
		case "ExpiredTokenException", "UnrecognizedClientException", "InvalidSignatureException":
			code = http.StatusUnauthorized
		case "AccessDeniedException":
			code = http.StatusForbidden
		case "ThrottlingException":
			code = http.StatusTooManyRequests
		}
	}
	switch code {
	case http.StatusUnauthorized:
		return apiutil.NewError(code, "provider_authentication_failed", "The provider rejected the saved credentials.", nil)
	case http.StatusForbidden:
		return apiutil.NewError(code, "provider_permission_denied", "The provider needs permission to list these resources.", nil)
	case http.StatusTooManyRequests:
		return apiutil.NewError(code, "provider_rate_limited", "The provider rate limited resource discovery. Try again later.", nil)
	case http.StatusNotFound:
		return apiutil.NewError(code, "provider_resource_not_found", "The provider resource or location was not found.", nil)
	default:
		return apiutil.NewError(http.StatusBadGateway, "provider_unavailable", "Provider resources could not be loaded. Try again.", nil)
	}
}

func discoverGoogleGuardrailResources(ctx context.Context, client *http.Client, input gatewayapi.GuardrailResourceDiscoveryInput, pageSize int, result *gatewayapi.GuardrailResourceDiscovery) *apiutil.APIError {
	if input.Kind == gatewayapi.GuardrailResourceDiscoveryInputKindProjects {
		return discoverGoogleProjects(ctx, client, input, pageSize, result)
	}
	parent := *input.Parent
	endpoint := url.URL{
		Scheme: "https",
		Host:   "modelarmor.googleapis.com",
		Path:   "/v1/" + parent + "/locations",
	}
	if input.Kind == gatewayapi.GuardrailResourceDiscoveryInputKindTemplates {
		parts := strings.Split(parent, "/")
		endpoint.Host = "modelarmor." + parts[3] + ".rep.googleapis.com"
		endpoint.Path = "/v1/" + parent + "/templates"
	}
	query := url.Values{"pageSize": []string{strconv.Itoa(pageSize)}}
	if input.PageToken != nil {
		query.Set("pageToken", *input.PageToken)
	}
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return guardrailDiscoveryError(err)
	}
	response, err := client.Do(request)
	if err != nil {
		return guardrailDiscoveryError(err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return guardrailDiscoveryError(&googleapi.Error{Code: response.StatusCode})
	}
	const maxBytes = 8 << 20
	body, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return guardrailDiscoveryError(err)
	}
	if len(body) > maxBytes {
		return apiutil.NewError(
			http.StatusBadGateway, "provider_response_invalid",
			"The provider resource response exceeded the size limit.", nil,
		)
	}
	decoder := protojson.UnmarshalOptions{DiscardUnknown: true}
	if input.Kind == gatewayapi.GuardrailResourceDiscoveryInputKindLocations {
		var page locationpb.ListLocationsResponse
		if err := decoder.Unmarshal(body, &page); err != nil {
			return apiutil.NewError(http.StatusBadGateway, "provider_response_invalid", "The provider returned invalid location information.", nil)
		}
		for _, location := range page.Locations {
			if location == nil || !guardrailGoogleLocation.MatchString(location.Name) || !strings.HasPrefix(location.Name, parent+"/locations/") {
				return apiutil.NewError(
					http.StatusBadGateway, "provider_response_invalid",
					"The provider returned an invalid location identifier.", nil,
				)
			}
			label := location.DisplayName
			if label == "" {
				label = location.LocationId
			}
			result.Items = append(result.Items, gatewayapi.GuardrailDiscoveredResource{Id: location.Name, Label: label})
		}
		if page.NextPageToken != "" {
			result.NextPageToken = &page.NextPageToken
		}
		return nil
	}
	var page modelarmorpb.ListTemplatesResponse
	if err := decoder.Unmarshal(body, &page); err != nil {
		return apiutil.NewError(http.StatusBadGateway, "provider_response_invalid", "The provider returned invalid template information.", nil)
	}
	for _, template := range page.Templates {
		if template == nil || !strings.HasPrefix(template.Name, parent+"/templates/") {
			return apiutil.NewError(http.StatusBadGateway, "provider_response_invalid", "The provider returned an invalid template identifier.", nil)
		}
		id := strings.TrimPrefix(template.Name, parent+"/templates/")
		if id == "" || len(id) > 63 || strings.ContainsAny(id, "/?# ") {
			return apiutil.NewError(http.StatusBadGateway, "provider_response_invalid", "The provider returned an invalid template identifier.", nil)
		}
		result.Items = append(result.Items, gatewayapi.GuardrailDiscoveredResource{Id: template.Name, Label: id})
	}
	if page.NextPageToken != "" {
		result.NextPageToken = &page.NextPageToken
	}
	if len(page.Unreachable) > 0 {
		result.Unreachable = &page.Unreachable
	}
	return nil
}
