package skill

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

const (
	// BucketSecretName is the tenant namespace Secret mounted by Agent init containers.
	BucketSecretName = "agentz-immutable-skills-bucket"

	// BucketSecretEndpointKey stores the S3-compatible endpoint URL.
	BucketSecretEndpointKey = "endpoint"
	// BucketSecretRegionKey stores the S3 region.
	BucketSecretRegionKey = "region"
	// BucketSecretBucketKey stores the bucket name.
	BucketSecretBucketKey = "bucket"
	// BucketSecretAccessKeyIDKey stores the S3 access key ID.
	BucketSecretAccessKeyIDKey = "access-key-id"
	// BucketSecretSecretAccessKeyKey stores the S3 secret access key.
	BucketSecretSecretAccessKeyKey = "secret-access-key"

	immutableDir = "immutable-skills"
	deleteBatch  = 1000
)

var skillNameRE = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// Config contains S3-compatible object storage settings.
type Config struct {
	Endpoint        string
	Region          string
	Bucket          string
	AccessKeyID     string
	SecretAccessKey string
}

// Manifest lists immutable skill versions to stage for one Agent pod.
type Manifest struct {
	Skills []ManifestSkill `json:"skills"`
}

// ManifestSkill describes one immutable skill version in a pod bootstrap manifest.
type ManifestSkill struct {
	Name        string `json:"name"`
	Version     int64  `json:"version"`
	StoragePath string `json:"storagePath"`
}

// Client wraps object storage operations needed by immutable skills.
type Client struct {
	bucket string
	s3     *s3.Client
}

// ConfigFromDir reads a mounted Kubernetes Secret directory into Config.
func ConfigFromDir(dir string) (Config, error) {
	endpoint, err := readSecretFile(dir, BucketSecretEndpointKey)
	if err != nil {
		return Config{}, err
	}
	region, err := readSecretFile(dir, BucketSecretRegionKey)
	if err != nil {
		return Config{}, err
	}
	bucket, err := readSecretFile(dir, BucketSecretBucketKey)
	if err != nil {
		return Config{}, err
	}
	accessKeyID, err := readSecretFile(dir, BucketSecretAccessKeyIDKey)
	if err != nil {
		return Config{}, err
	}
	secretAccessKey, err := readSecretFile(dir, BucketSecretSecretAccessKeyKey)
	if err != nil {
		return Config{}, err
	}
	return Config{
		Endpoint:        endpoint,
		Region:          region,
		Bucket:          bucket,
		AccessKeyID:     accessKeyID,
		SecretAccessKey: secretAccessKey,
	}, nil
}

// SecretData returns Kubernetes Secret data for immutable skill downloads.
func (c Config) SecretData() map[string][]byte {
	return map[string][]byte{
		BucketSecretEndpointKey:        []byte(c.Endpoint),
		BucketSecretRegionKey:          []byte(c.Region),
		BucketSecretBucketKey:          []byte(c.Bucket),
		BucketSecretAccessKeyIDKey:     []byte(c.AccessKeyID),
		BucketSecretSecretAccessKeyKey: []byte(c.SecretAccessKey),
	}
}

// Validate reports whether all required storage settings are present.
func (c Config) Validate() error {
	if strings.TrimSpace(c.Endpoint) == "" {
		return fmt.Errorf("skills s3 endpoint is required")
	}
	if strings.TrimSpace(c.Region) == "" {
		return fmt.Errorf("skills s3 region is required")
	}
	if strings.TrimSpace(c.Bucket) == "" {
		return fmt.Errorf("skills s3 bucket is required")
	}
	if strings.TrimSpace(c.AccessKeyID) == "" {
		return fmt.Errorf("skills s3 access key id is required")
	}
	if strings.TrimSpace(c.SecretAccessKey) == "" {
		return fmt.Errorf("skills s3 secret access key is required")
	}
	return nil
}

// New creates an object storage client.
func New(ctx context.Context, c Config) (*Client, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	cfg, err := config.LoadDefaultConfig(
		ctx,
		config.WithRegion(c.Region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			c.AccessKeyID,
			c.SecretAccessKey,
			"",
		)),
	)
	if err != nil {
		return nil, fmt.Errorf("load s3 config: %w", err)
	}
	return &Client{
		bucket: c.Bucket,
		s3: s3.NewFromConfig(cfg, func(o *s3.Options) {
			o.BaseEndpoint = aws.String(c.Endpoint)
			o.UsePathStyle = true
		}),
	}, nil
}

// ImmutableSkillPrefix returns the object key prefix for all versions of one immutable skill.
func ImmutableSkillPrefix(namespace, name string) string {
	return namespace + "/" + immutableDir + "/" + name + "/"
}

// ImmutableVersionPrefix returns the object key prefix for one immutable skill version.
func ImmutableVersionPrefix(namespace, name string, version int64) string {
	return ImmutableSkillPrefix(namespace, name) + "v" + strconv.FormatInt(version, 10) + "/"
}

// StoragePath returns the full S3 URI for one immutable skill version.
func (c Config) StoragePath(namespace, name string, version int64) string {
	return "s3://" + c.Bucket + "/" + ImmutableVersionPrefix(namespace, name, version)
}

// DeleteImmutableSkill deletes every stored version of one immutable skill.
func (c *Client) DeleteImmutableSkill(ctx context.Context, namespace, name string) error {
	return c.DeletePrefix(ctx, c.bucket, ImmutableSkillPrefix(namespace, name))
}

// DeletePrefix deletes all objects below bucket/prefix.
func (c *Client) DeletePrefix(ctx context.Context, bucket, prefix string) error {
	var keys []s3types.ObjectIdentifier
	paginator := s3.NewListObjectsV2Paginator(c.s3, &s3.ListObjectsV2Input{
		Bucket: aws.String(bucket),
		Prefix: aws.String(prefix),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("list s3 prefix: %w", err)
		}
		for _, item := range page.Contents {
			if item.Key == nil {
				continue
			}
			keys = append(keys, s3types.ObjectIdentifier{Key: item.Key})
			if len(keys) == deleteBatch {
				if err := c.deleteKeys(ctx, bucket, keys); err != nil {
					return err
				}
				keys = keys[:0]
			}
		}
	}
	if len(keys) == 0 {
		return nil
	}
	return c.deleteKeys(ctx, bucket, keys)
}

// DownloadManifest stages all immutable skills from manifestPath into targetDir.
func (c *Client) DownloadManifest(ctx context.Context, manifestPath, targetDir string) error {
	file, err := os.Open(manifestPath)
	if err != nil {
		return fmt.Errorf("open immutable skill manifest: %w", err)
	}
	defer file.Close()

	var manifest Manifest
	if err := json.NewDecoder(file).Decode(&manifest); err != nil {
		return fmt.Errorf("decode immutable skill manifest: %w", err)
	}
	slices.SortFunc(manifest.Skills, func(a, b ManifestSkill) int {
		return strings.Compare(a.Name, b.Name)
	})
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return fmt.Errorf("create immutable skill root: %w", err)
	}
	for _, skill := range manifest.Skills {
		if !skillNameRE.MatchString(skill.Name) {
			return fmt.Errorf("invalid immutable skill name")
		}
		bucket, prefix, err := ParseStoragePath(skill.StoragePath)
		if err != nil {
			return err
		}
		if bucket != c.bucket {
			return fmt.Errorf("immutable skill bucket %q is not configured", bucket)
		}
		dst := filepath.Join(targetDir, skill.Name)
		if err := os.RemoveAll(dst); err != nil {
			return fmt.Errorf("clear immutable skill directory: %w", err)
		}
		if err := c.DownloadPrefix(ctx, bucket, prefix, dst); err != nil {
			return fmt.Errorf("download immutable skill %q: %w", skill.Name, err)
		}
	}
	return nil
}

// DownloadPrefix copies all objects below bucket/prefix into targetDir.
func (c *Client) DownloadPrefix(ctx context.Context, bucket, prefix, targetDir string) error {
	paginator := s3.NewListObjectsV2Paginator(c.s3, &s3.ListObjectsV2Input{
		Bucket: aws.String(bucket),
		Prefix: aws.String(prefix),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("list s3 prefix: %w", err)
		}
		for _, item := range page.Contents {
			if item.Key == nil || strings.HasSuffix(*item.Key, "/") {
				continue
			}
			if err := c.downloadObject(ctx, bucket, prefix, *item.Key, targetDir); err != nil {
				return err
			}
		}
	}
	return nil
}

// ParseStoragePath splits an s3://bucket/prefix URI.
func ParseStoragePath(path string) (string, string, error) {
	rest, ok := strings.CutPrefix(path, "s3://")
	if !ok {
		return "", "", fmt.Errorf("skill storage path must be an s3 uri")
	}
	bucket, prefix, ok := strings.Cut(rest, "/")
	if !ok || bucket == "" || prefix == "" {
		return "", "", fmt.Errorf("skill storage path must include bucket and prefix")
	}
	if strings.Contains(prefix, "\\") {
		return "", "", fmt.Errorf("skill storage path prefix is unsafe")
	}
	trimmed := strings.TrimSuffix(prefix, "/")
	for part := range strings.SplitSeq(trimmed, "/") {
		if part == "" || part == "." || part == ".." {
			return "", "", fmt.Errorf("skill storage path prefix is unsafe")
		}
	}
	prefix = trimmed
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return bucket, prefix, nil
}

func readSecretFile(dir, name string) (string, error) {
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return "", fmt.Errorf("read bucket secret %q: %w", name, err)
	}
	value := strings.TrimSpace(string(data))
	if value == "" {
		return "", fmt.Errorf("bucket secret %q is empty", name)
	}
	return value, nil
}

func (c *Client) deleteKeys(ctx context.Context, bucket string, keys []s3types.ObjectIdentifier) error {
	_, err := c.s3.DeleteObjects(ctx, &s3.DeleteObjectsInput{
		Bucket: aws.String(bucket),
		Delete: &s3types.Delete{
			Objects: keys,
			Quiet:   aws.Bool(true),
		},
	})
	if err != nil {
		return fmt.Errorf("delete s3 objects: %w", err)
	}
	return nil
}

func (c *Client) downloadObject(ctx context.Context, bucket, prefix, key, targetDir string) error {
	rel, ok := strings.CutPrefix(key, prefix)
	if !ok || rel == "" {
		return nil
	}
	local, err := localPath(targetDir, rel)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
		return fmt.Errorf("create immutable skill directory: %w", err)
	}
	object, err := c.s3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("get s3 object: %w", err)
	}
	defer object.Body.Close()

	file, err := os.OpenFile(local, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("open immutable skill file: %w", err)
	}
	defer file.Close()
	if _, err := io.Copy(file, object.Body); err != nil {
		return fmt.Errorf("write immutable skill file: %w", err)
	}
	return nil
}

func localPath(root, rel string) (string, error) {
	if rel == "" {
		return "", errors.New("empty object key")
	}
	clean := filepath.Clean(rel)
	if clean == "." ||
		clean == ".." ||
		filepath.IsAbs(clean) ||
		strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("unsafe object key")
	}
	return filepath.Join(root, clean), nil
}
