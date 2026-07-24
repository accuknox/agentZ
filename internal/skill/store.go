package skill

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
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

	immutableDir            = "immutable-skills"
	deleteBatch             = 1000
	maxStoredFiles          = 200
	maxStoredFileBytes      = 1024 * 1024
	maxStoredSkillFileBytes = 64 * 1024
	maxStoredTotalBytes     = 20 * 1024 * 1024
)

var namespaceNameRE = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// ErrVersionExists indicates that an immutable version's first object already
// exists and the version cannot be created conditionally.
var ErrVersionExists = errors.New("immutable skill version already exists")

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
	Namespace string          `json:"namespace"`
	Skills    []ManifestSkill `json:"skills"`
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

// Summary describes the stored files for one immutable skill version.
type Summary struct {
	FileCount int
	SizeBytes int64
	Modified  *time.Time
}

// VersionSelection identifies one immutable skill version for export.
type VersionSelection struct {
	Name    string
	Version int64
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
		return errors.New("skills s3 endpoint is required")
	}
	if strings.TrimSpace(c.Region) == "" {
		return errors.New("skills s3 region is required")
	}
	if strings.TrimSpace(c.Bucket) == "" {
		return errors.New("skills s3 bucket is required")
	}
	if strings.TrimSpace(c.AccessKeyID) == "" {
		return errors.New("skills s3 access key id is required")
	}
	if strings.TrimSpace(c.SecretAccessKey) == "" {
		return errors.New("skills s3 secret access key is required")
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

func immutableSkillPrefix(namespace, name string) string {
	return namespace + "/" + immutableDir + "/" + name + "/"
}

func immutableVersionPrefix(namespace, name string, version int64) string {
	return immutableSkillPrefix(namespace, name) + "v" + strconv.FormatInt(version, 10) + "/"
}

// StoragePath returns the full S3 URI for one immutable skill version.
func (c Config) StoragePath(namespace, name string, version int64) string {
	return "s3://" + c.Bucket + "/" + immutableVersionPrefix(namespace, name, version)
}

// ParseStoragePath splits an S3 storage URI into its bucket and object prefix.
func ParseStoragePath(storagePath string) (string, string, error) {
	rest, ok := strings.CutPrefix(storagePath, "s3://")
	if !ok {
		return "", "", errors.New("skill storage path must be an s3 URI")
	}
	bucket, prefix, ok := strings.Cut(rest, "/")
	prefix = strings.TrimSuffix(prefix, "/")
	if !ok || bucket == "" || prefix == "" || !fs.ValidPath(prefix) {
		return "", "", errors.New("skill storage path must contain a safe bucket and prefix")
	}
	return bucket, prefix + "/", nil
}

// DeleteImmutableSkill deletes every stored version of one immutable skill.
func (c *Client) DeleteImmutableSkill(ctx context.Context, namespace, name string) error {
	return c.deletePrefix(ctx, c.bucket, immutableSkillPrefix(namespace, name))
}

// DeleteVersion deletes one stored immutable skill version.
func (c *Client) DeleteVersion(ctx context.Context, namespace, name string, version int64) error {
	return c.deletePrefix(ctx, c.bucket, immutableVersionPrefix(namespace, name, version))
}

// Versions returns sorted immutable skill versions present in object storage.
func (c *Client) Versions(ctx context.Context, namespace, name string) ([]int64, error) {
	prefix := immutableSkillPrefix(namespace, name)
	versions := []int64{}
	paginator := s3.NewListObjectsV2Paginator(c.s3, &s3.ListObjectsV2Input{
		Bucket: aws.String(c.bucket), Delimiter: aws.String("/"), Prefix: aws.String(prefix),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("list immutable skill versions: %w", err)
		}
		for _, item := range page.CommonPrefixes {
			if item.Prefix == nil {
				continue
			}
			value := strings.TrimSuffix(strings.TrimPrefix(*item.Prefix, prefix), "/")
			value, ok := strings.CutPrefix(value, "v")
			if !ok {
				continue
			}
			version, err := strconv.ParseInt(value, 10, 64)
			if err != nil || version < 1 {
				continue
			}
			versions = append(versions, version)
		}
	}
	slices.Sort(versions)
	return versions, nil
}

// VersionSummary calculates file metadata for one immutable skill version.
func (c *Client) VersionSummary(ctx context.Context, namespace, name string, version int64) (Summary, error) {
	prefix := immutableVersionPrefix(namespace, name, version)
	var summary Summary
	paginator := s3.NewListObjectsV2Paginator(c.s3, &s3.ListObjectsV2Input{
		Bucket: aws.String(c.bucket), Prefix: aws.String(prefix),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return Summary{}, fmt.Errorf("summarize immutable skill version: %w", err)
		}
		for _, item := range page.Contents {
			if item.Key == nil || strings.HasSuffix(*item.Key, "/") {
				continue
			}
			summary.FileCount++
			summary.SizeBytes += aws.ToInt64(item.Size)
			if item.LastModified != nil && (summary.Modified == nil || item.LastModified.After(*summary.Modified)) {
				modified := *item.LastModified
				summary.Modified = &modified
			}
		}
	}
	if summary.FileCount == 0 {
		return Summary{}, fs.ErrNotExist
	}
	return summary, nil
}

// UploadVersion conditionally creates one complete immutable skill version.
func (c *Client) UploadVersion(ctx context.Context, namespace string, tree Tree, version int64) error {
	files := slices.Clone(tree.Files)
	slices.SortFunc(files, func(a, b File) int {
		if a.Path == b.Path {
			return 0
		}
		if a.Path == skillFileName {
			return -1
		}
		if b.Path == skillFileName {
			return 1
		}
		return strings.Compare(a.Path, b.Path)
	})
	prefix := immutableVersionPrefix(namespace, tree.Name, version)
	uploaded := make([]s3types.ObjectIdentifier, 0, len(files))
	for _, file := range files {
		key := prefix + file.Path
		input := &s3.PutObjectInput{
			Bucket: aws.String(c.bucket), Key: aws.String(key), Body: bytes.NewReader(file.Content),
		}
		if len(uploaded) == 0 {
			input.IfNoneMatch = aws.String("*")
		}
		if _, err := c.s3.PutObject(ctx, input); err != nil {
			var apiErr smithy.APIError
			if len(uploaded) == 0 && errors.As(err, &apiErr) {
				code := apiErr.ErrorCode()
				if code == "PreconditionFailed" || code == "ConditionalRequestConflict" {
					return errors.Join(ErrVersionExists, err)
				}
			}
			var cleanupErr error
			if len(uploaded) > 0 {
				cleanupErr = c.deleteKeys(ctx, c.bucket, uploaded)
			}
			return errors.Join(fmt.Errorf("upload immutable skill version: %w", err), cleanupErr)
		}
		uploaded = append(uploaded, s3types.ObjectIdentifier{Key: aws.String(key)})
	}
	return nil
}

// WriteVersionsZIP streams immutable skill versions into a portable ZIP.
func (c *Client) WriteVersionsZIP(ctx context.Context, w io.Writer, namespace string, selections []VersionSelection) error {
	selections = slices.Clone(selections)
	slices.SortFunc(selections, func(a, b VersionSelection) int {
		return strings.Compare(a.Name, b.Name)
	})
	zw := zip.NewWriter(w)
	for _, selection := range selections {
		prefix := immutableVersionPrefix(namespace, selection.Name, selection.Version)
		paginator := s3.NewListObjectsV2Paginator(c.s3, &s3.ListObjectsV2Input{
			Bucket: aws.String(c.bucket), Prefix: aws.String(prefix),
		})
		for paginator.HasMorePages() {
			page, err := paginator.NextPage(ctx)
			if err != nil {
				return errors.Join(fmt.Errorf("list immutable skill export: %w", err), zw.Close())
			}
			for _, item := range page.Contents {
				if item.Key == nil || strings.HasSuffix(*item.Key, "/") {
					continue
				}
				rel, ok := strings.CutPrefix(*item.Key, prefix)
				if !ok || !fs.ValidPath(rel) {
					return errors.Join(errors.New("immutable skill object key is unsafe"), zw.Close())
				}
				object, err := c.s3.GetObject(ctx, &s3.GetObjectInput{
					Bucket: aws.String(c.bucket), Key: item.Key,
				})
				if err != nil {
					return errors.Join(fmt.Errorf("get immutable skill export object: %w", err), zw.Close())
				}
				h := &zip.FileHeader{
					Name: path.Join(selection.Name, rel), Method: zip.Deflate,
				}
				dst, err := zw.CreateHeader(h)
				if err != nil {
					return errors.Join(fmt.Errorf("create immutable skill export entry: %w", err), object.Body.Close(), zw.Close())
				}
				_, copyErr := io.Copy(dst, object.Body)
				closeErr := object.Body.Close()
				if err := errors.Join(copyErr, closeErr); err != nil {
					return errors.Join(fmt.Errorf("write immutable skill export: %w", err), zw.Close())
				}
			}
		}
	}
	if err := zw.Close(); err != nil {
		return fmt.Errorf("close immutable skill export: %w", err)
	}
	return nil
}

func (c *Client) deletePrefix(ctx context.Context, bucket, prefix string) error {
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
	if manifest.Namespace == "" || len(manifest.Namespace) > 63 || !namespaceNameRE.MatchString(manifest.Namespace) {
		return errors.New("immutable skill manifest namespace is invalid")
	}
	slices.SortFunc(manifest.Skills, func(a, b ManifestSkill) int {
		return strings.Compare(a.Name, b.Name)
	})

	targetDir, err = filepath.Abs(targetDir)
	if err != nil {
		return fmt.Errorf("resolve immutable skill root: %w", err)
	}
	if filepath.Dir(targetDir) == targetDir {
		return errors.New("immutable skill root must not be a filesystem root")
	}
	if err := os.MkdirAll(filepath.Dir(targetDir), 0o755); err != nil {
		return fmt.Errorf("create immutable skill parent: %w", err)
	}
	staging, err := os.MkdirTemp(filepath.Dir(targetDir), ".immutable-skills-")
	if err != nil {
		return fmt.Errorf("create immutable skill staging directory: %w", err)
	}
	defer os.RemoveAll(staging)

	for i, item := range manifest.Skills {
		if ValidateName(item.Name) != nil {
			return errors.New("immutable skill name is invalid")
		}
		if i > 0 && manifest.Skills[i-1].Name == item.Name {
			return errors.New("immutable skill manifest contains duplicate names")
		}
		if item.Version < 1 {
			return errors.New("immutable skill version is invalid")
		}
		if item.StoragePath != (Config{Bucket: c.bucket}).StoragePath(
			manifest.Namespace,
			item.Name,
			item.Version,
		) {
			return errors.New("immutable skill storage path does not match its identity")
		}
		dst := filepath.Join(staging, item.Name)
		prefix := immutableVersionPrefix(manifest.Namespace, item.Name, item.Version)
		if err := c.downloadSkill(ctx, prefix, dst); err != nil {
			return fmt.Errorf("download immutable skill %q: %w", item.Name, err)
		}
		if err := Validate(dst); err != nil {
			return fmt.Errorf("validate immutable skill %q: %w", item.Name, err)
		}
	}

	return replaceDirectory(staging, targetDir)
}

func (c *Client) downloadSkill(ctx context.Context, prefix, targetDir string) error {
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return fmt.Errorf("create immutable skill directory: %w", err)
	}
	root, err := os.OpenRoot(targetDir)
	if err != nil {
		return fmt.Errorf("open immutable skill directory: %w", err)
	}
	defer root.Close()

	var fileCount int
	var totalBytes int64
	var hasSkillFile bool
	paginator := s3.NewListObjectsV2Paginator(c.s3, &s3.ListObjectsV2Input{
		Bucket: aws.String(c.bucket),
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
			rel, ok := strings.CutPrefix(*item.Key, prefix)
			if !ok || !fs.ValidPath(rel) {
				return errors.New("immutable skill object key is unsafe")
			}
			fileCount++
			if fileCount > maxStoredFiles {
				return errors.New("immutable skill contains too many files")
			}
			limit := int64(maxStoredFileBytes)
			if rel == skillFileName {
				limit = maxStoredSkillFileBytes
				hasSkillFile = true
			}
			if size := aws.ToInt64(item.Size); size < 0 || size > limit {
				return fmt.Errorf("immutable skill file %q is too large", rel)
			}
			n, err := c.downloadObject(ctx, root, *item.Key, rel, limit)
			if err != nil {
				return err
			}
			totalBytes += n
			if totalBytes > maxStoredTotalBytes {
				return errors.New("immutable skill contains too much data")
			}
		}
	}
	if fileCount == 0 {
		return errors.New("immutable skill storage prefix is empty")
	}
	if !hasSkillFile {
		return errors.New("immutable skill is missing SKILL.md")
	}
	return nil
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
	result, err := c.s3.DeleteObjects(ctx, &s3.DeleteObjectsInput{
		Bucket: aws.String(bucket),
		Delete: &s3types.Delete{
			Objects: keys,
			Quiet:   aws.Bool(true),
		},
	})
	if err != nil {
		return fmt.Errorf("delete s3 objects: %w", err)
	}
	if len(result.Errors) > 0 {
		return fmt.Errorf("delete s3 objects: %d object failures", len(result.Errors))
	}
	return nil
}

func (c *Client) downloadObject(ctx context.Context, root *os.Root, key, rel string, limit int64) (int64, error) {
	if err := root.MkdirAll(path.Dir(rel), 0o755); err != nil {
		return 0, fmt.Errorf("create immutable skill directory: %w", err)
	}
	object, err := c.s3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return 0, fmt.Errorf("get s3 object: %w", err)
	}

	file, err := root.Create(rel)
	if err != nil {
		return 0, errors.Join(
			fmt.Errorf("open immutable skill file: %w", err),
			object.Body.Close(),
		)
	}
	n, copyErr := io.Copy(file, io.LimitReader(object.Body, limit+1))
	err = errors.Join(copyErr, file.Close(), object.Body.Close())
	if err != nil {
		return 0, fmt.Errorf("write immutable skill file: %w", err)
	}
	if n > limit {
		return 0, fmt.Errorf("immutable skill file %q is too large", rel)
	}
	return n, nil
}

func replaceDirectory(staging, target string) error {
	backup := target + ".previous"
	if err := os.RemoveAll(backup); err != nil {
		return fmt.Errorf("remove previous immutable skill backup: %w", err)
	}
	hadTarget := true
	if err := os.Rename(target, backup); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("preserve current immutable skills: %w", err)
		}
		hadTarget = false
	}
	if err := os.Rename(staging, target); err != nil {
		if !hadTarget {
			return fmt.Errorf("activate immutable skills: %w", err)
		}
		return errors.Join(
			fmt.Errorf("activate immutable skills: %w", err),
			os.Rename(backup, target),
		)
	}
	if !hadTarget {
		return nil
	}
	if err := os.RemoveAll(backup); err != nil {
		return fmt.Errorf("remove replaced immutable skills: %w", err)
	}
	return nil
}
