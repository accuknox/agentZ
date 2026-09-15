# Self-hosting guide: Quick start

## Prerequisites

- Box with minimum 4 GiB memory, 2 vCPU, 50 GiB disk
- Root access to the box

## Install K3S

```
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC='--flannel-backend=none --disable-network-policy' sh -
```

Read more: <https://docs.k3s.io/installation>

## Install Cilium CNI

1. Download the cilium CLI

```
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
CLI_ARCH=amd64
if [ "$(uname -m)" = "aarch64" ]; then CLI_ARCH=arm64; fi
curl -L --fail --remote-name-all https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-${CLI_ARCH}.tar.gz{,.sha256sum}
sha256sum --check cilium-linux-${CLI_ARCH}.tar.gz.sha256sum
sudo tar xzvfC cilium-linux-${CLI_ARCH}.tar.gz /usr/local/bin
rm cilium-linux-${CLI_ARCH}.tar.gz{,.sha256sum}
```

2. Install Cilium

```
cilium install --version 1.19.5 \
  --set ipam.operator.clusterPoolIPv4PodCIDRList=10.42.0.0/16 \
  --set operator.replicas=1
cilium status --wait
```

Read more: <https://docs.cilium.io/en/stable/gettingstarted/k8s-install-default/>

## Enable Hubble

```
cilium hubble enable
```

Read more: <https://docs.cilium.io/en/stable/observability/hubble/setup/#hubble-setup>

## Install Cert-Manager

```
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.21.2/cert-manager.yaml
```

Read more: <https://cert-manager.io/docs/installation/>

## Install KubeArmor

```
# sudo access is needed to install it in /usr/local/bin directory. But, if you prefer not to use sudo, you can install it in a different directory which is in your PATH.
curl -sfL http://get.kubearmor.io/ | sudo sh -s -- -b /usr/local/bin

# make sure kubeconfig and kubectl context is pointing to the correct cluster
karmor install --host-viz=none --viz=none
```

## Install External Secrets Operator

```
helm repo add external-secrets https://charts.external-secrets.io

helm install external-secrets \
    external-secrets/external-secrets \
    -n external-secrets \
    --create-namespace \
    --set installCRDs=true
```

Read more: <https://external-secrets.io/latest/introduction/getting-started/>

## Install AgentGateway

Install the Gateway API CRDs first. On this fresh K3s cluster,
`--force-conflicts` updates the CRDs bundled by Traefik.

```bash
kubectl apply --server-side --force-conflicts -f \
  https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.0/standard-install.yaml
```

```
helm upgrade -i --create-namespace \
  --namespace agentgateway-system \
  --version v1.5.0 agentgateway-crds oci://cr.agentgateway.dev/charts/agentgateway-crds

helm upgrade -i -n agentgateway-system agentgateway oci://cr.agentgateway.dev/charts/agentgateway --version v1.5.0
```

Read more: <https://agentgateway.dev/docs/kubernetes/latest/documentation/install/helm/>

## Install Postgesql using CNPG

1. Install CNPG operator

```
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.30/releases/cnpg-1.30.0.yaml
kubectl rollout status deployment/cnpg-controller-manager -n cnpg-system --timeout=180s
```

2. Create single node Postgresql cluster

```
kubectl create -f - <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: agentz
  namespace: cnpg-system
spec:
  instances: 1
  storage:
    size: 10Gi
EOF
```

```bash
kubectl wait cluster/agentz -n cnpg-system --for=condition=Ready --timeout=300s
```

## Install OpenBao

```bash
cat > openbao-values.yaml <<'YAML'
injector:
  enabled: false
server:
  dataStorage:
    size: 10Gi
  standalone:
    enabled: true
ui:
  enabled: true
YAML

helm repo add openbao https://openbao.github.io/openbao-helm
helm upgrade --install openbao openbao/openbao \
  --namespace openbao --create-namespace --version 0.29.1 \
  -f openbao-values.yaml

helm repo add vault-autounseal https://pytoshka.github.io/vault-autounseal
helm upgrade --install autounseal vault-autounseal/vault-autounseal \
  --namespace openbao --version 0.5.3 \
  --set settings.vault_url=http://openbao.openbao.svc.cluster.local:8200 \
  --set settings.vault_label_selector='app.kubernetes.io/instance=openbao\,component=server' \
  --set settings.vault_root_token_secret=root-token \
  --set settings.vault_keys_secret=shards \
  --wait --timeout 5m

kubectl wait pod/openbao-0 -n openbao --for=condition=Ready --timeout=180s
kubectl exec -n openbao openbao-0 -- bao status
```

Configure KV v2, Kubernetes authentication and the AgentZ roles:

```bash
kubectl get secret root-token -n openbao -o jsonpath='{.data.root_token}' | base64 -d > bao-token

bao() {
  { cat bao-token; printf '\n'; } | kubectl exec -i -n openbao openbao-0 -- \
    sh -c 'read -r BAO_TOKEN; export BAO_TOKEN; exec bao "$@"' sh "$@"
}

bao secrets enable -path=kv kv-v2
bao auth enable kubernetes
bao write auth/kubernetes/config kubernetes_host=https://kubernetes.default.svc:443

cat > manager-policy.hcl <<'HCL'
path "sys/policies/acl/sinjector-*" {
  capabilities = ["create", "read", "update", "delete"]
}

path "sys/policies/acl/extauth-*" {
  capabilities = ["create", "read", "update", "delete"]
}

path "auth/kubernetes/role/sinjector-*" {
  capabilities = ["create", "read", "update", "delete"]
}

path "auth/kubernetes/role/extauth-*" {
  capabilities = ["create", "read", "update", "delete"]
}

path "kv/metadata/*" {
  capabilities = ["delete"]
}
HCL

cat > gateway-policy.hcl <<'HCL'
path "kv/data/+/*" {
  capabilities = ["create", "update", "delete"]
}

path "kv/metadata/+/*" {
  capabilities = ["delete"]
}

path "kv/data/+/inference-provider-oauth-tickets/*" {
  capabilities = ["create", "read", "update", "delete"]
}

path "kv/data/+/inference-subscriptions/*" {
  capabilities = ["create", "read", "update", "delete"]
}

path "kv/metadata/+/inference-provider-oauth-tickets/*" {
  capabilities = ["create", "update", "delete"]
}
HCL

cat > inference-policy.hcl <<'HCL'
path "kv/data/+/inference-providers/+" {
  capabilities = ["read"]
}

path "kv/metadata/+/inference-providers/+" {
  capabilities = ["read"]
}
HCL

bao write sys/policies/acl/manager policy="$(cat manager-policy.hcl)"
bao write sys/policies/acl/gateway policy="$(cat gateway-policy.hcl)"
bao write sys/policies/acl/agentz-inference-external-secrets policy="$(cat inference-policy.hcl)"

bao write auth/kubernetes/role/manager \
  bound_service_account_names=agentz-manager \
  bound_service_account_namespaces=agentz-system \
  token_policies=manager token_period=1h

bao write auth/kubernetes/role/gateway \
  bound_service_account_names=agentz-gateway \
  bound_service_account_namespaces=agentz-system \
  token_policies=gateway token_period=1h

bao write auth/kubernetes/role/agentz-inference-external-secrets \
  bound_service_account_names=agentz-inference-external-secrets \
  bound_service_account_namespaces=agentz-system \
  audience=https://kubernetes.default.svc \
  token_policies=agentz-inference-external-secrets token_ttl=1h

rm bao-token
unset -f bao
```

Read more: <https://openbao.org/docs/auth/kubernetes/>

## Install RustFS

Assuming your domain is `example.com`, create these DNS records:

| Type  | Name                    | Value                |
|-------|-------------------------|----------------------|
| A     | `agentz.example.com`    | Host's public IPv4   |
| CNAME | `s3.agentz.example.com` | `agentz.example.com` |

**NOTE**: Allow public TCP 80/443 for Traefik and ACME

Replace the example domain names and email addresses below with your own.
These environment variables are crucial and are used throughout this guide.

```bash
export AGENTZ_HOST=agentz.example.com
export S3_HOST=s3.agentz.example.com
export ACME_EMAIL=ops@example.com
export ADMIN_EMAIL=you@example.com
export AGENTZ_VERSION=v0.21.0

kubectl rollout status deployment/cert-manager-webhook -n cert-manager --timeout=180s

kubectl apply -f - <<YAML
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
spec:
  acme:
    email: ${ACME_EMAIL}
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-account
    solvers:
    - http01:
        ingress:
          ingressClassName: traefik
YAML
```

`selfsigned` ClusterIssuer issues tenant secret-injection CA certificates.
`letsencrypt` issues the public web and S3 certificates.

Finally, install RustFS:

```bash
kubectl create namespace rustfs
printf 'RUSTFS_ACCESS_KEY=%s\nRUSTFS_SECRET_KEY=%s\n' "$(openssl rand -hex 12)" "$(openssl rand -hex 32)" > rustfs.env
kubectl create secret generic rustfs -n rustfs --from-env-file=rustfs.env

cat > rustfs-values.yaml <<'YAML'
replicaCount: 1
mode:
  standalone:
    enabled: true
  distributed:
    enabled: false
secret:
  existingSecret: rustfs
storageclass:
  name: local-path
  dataStorageSize: 10Gi
  logStorageSize: 1Gi
ingress:
  enabled: false
YAML

helm repo add rustfs https://charts.rustfs.com
helm upgrade --install rustfs rustfs/rustfs --namespace rustfs --version 0.12.0 -f rustfs-values.yaml --wait --timeout 5m
```

Allow package jobs to reach the RustFS Service. AgentZ's generated FQDN rules
do not admit traffic to Cilium-managed RustFS pods. This additional rule
allows TCP 9000 for package jobs only.

```bash
kubectl apply -f - <<'YAML'
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: agentz-package-jobs-rustfs
spec:
  endpointSelector:
    matchExpressions:
    - key: k8s:agentz.accuknox.com/agent-package-job
      operator: Exists
  egress:
  - toServices:
    - k8sService:
        serviceName: rustfs-svc
        namespace: rustfs
    toPorts:
    - ports:
      - port: "9000"
        protocol: TCP
YAML
```

The web app returns presigned URLs to browsers, so an internal S3 endpoint
would break organization image uploads. Therefore, we must expose the S3 API
over HTTPS.

```bash
kubectl apply -f - <<YAML
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: rustfs-s3
  namespace: rustfs
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
spec:
  ingressClassName: traefik
  tls:
  - hosts: ["${S3_HOST}"]
    secretName: rustfs-s3-tls
  rules:
  - host: ${S3_HOST}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: rustfs-svc
            port:
              number: 9000
YAML

kubectl wait certificate/rustfs-s3-tls -n rustfs --for=condition=Ready --timeout=300s
curl --retry 10 --retry-delay 2 --retry-all-errors -fsS "https://${S3_HOST}/health/ready"
```

Use [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
to create `agentz` for private skills and `agentz-assets` for organization images.

```bash
set -a
. ./rustfs.env
set +a

(
set -e
export AWS_ACCESS_KEY_ID="$RUSTFS_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$RUSTFS_SECRET_KEY"
export AWS_DEFAULT_REGION=us-east-1
export AWS_ENDPOINT_URL_S3="https://${S3_HOST}"
export AWS_PAGER=""
unset AWS_SESSION_TOKEN AWS_PROFILE AWS_DEFAULT_PROFILE
export AWS_CONFIG_FILE="$(mktemp)"
trap 'rm -f "$AWS_CONFIG_FILE"' EXIT
aws configure set default.s3.addressing_style path

for bucket in agentz agentz-assets; do
  aws s3api create-bucket --bucket "$bucket"
done

cat > assets-policy.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": "*",
    "Action": ["s3:GetObject"],
    "Resource": ["arn:aws:s3:::agentz-assets/organization-profiles/*"]
  }]
}
JSON
aws s3api put-bucket-policy --bucket agentz-assets --policy file://assets-policy.json

cat > assets-cors.json <<JSON
{
  "CORSRules": [{
    "AllowedOrigins": ["https://${AGENTZ_HOST}"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }]
}
JSON
aws s3api put-bucket-cors --bucket agentz-assets --cors-configuration file://assets-cors.json

printf 'private' > selfhost-check
aws s3api put-object --bucket agentz --key selfhost-check --body selfhost-check
aws s3api get-object --bucket agentz --key selfhost-check selfhost-check.download
cmp selfhost-check selfhost-check.download
aws s3api delete-object --bucket agentz --key selfhost-check
rm selfhost-check selfhost-check.download
)
```

Read more: <https://github.com/rustfs/helm>

## Create necessary AgentZ secrets

Create the Secret for database access, authentication, and S3 credentials:

```bash
kubectl create namespace agentz-system
DB_URL=$(kubectl get secret agentz-app -n cnpg-system -o jsonpath='{.data.uri}' | base64 -d)

kubectl create -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: agentz
  namespace: agentz-system
type: Opaque
stringData:
  DATABASE_URL: "${DB_URL}?uselibpqcompat=true&sslmode=require"
  AGENTZ_POSTGRES_DSN: "${DB_URL}?sslmode=require"
  BETTER_AUTH_SECRET: "$(openssl rand -hex 32)"
  MCP_OAUTH_COOKIE_SECRET: "$(openssl rand -hex 32)"
  AGENTZ_SKILLS_S3_ACCESS_KEY_ID: "${RUSTFS_ACCESS_KEY}"
  AGENTZ_SKILLS_S3_SECRET_ACCESS_KEY: "${RUSTFS_SECRET_KEY}"
  ORGANIZATION_ASSETS_S3_ACCESS_KEY_ID: "${RUSTFS_ACCESS_KEY}"
  ORGANIZATION_ASSETS_S3_SECRET_ACCESS_KEY: "${RUSTFS_SECRET_KEY}"
EOF

unset DB_URL RUSTFS_ACCESS_KEY RUSTFS_SECRET_KEY
```

The values in the next section enable only email/password sign-in for
`ADMIN_EMAIL`. For GitHub/Google sign in, please refer [this](./social-login.md)
guide.

## Install AgentZ

Create the values file:

```bash
cat > agentz-values.yaml <<YAML
manager:
  image:
    tag: ${AGENTZ_VERSION}
  resources:
    limits:
      memory: 512Mi
  config:
    controllerImage: public.ecr.aws/k9v9d5v2/agentz:${AGENTZ_VERSION}
    agentImage: public.ecr.aws/k9v9d5v2/agentz/agent:${AGENTZ_VERSION}
    agentInitImage: public.ecr.aws/k9v9d5v2/agentz/init:${AGENTZ_VERSION}
    skillsS3Endpoint: http://rustfs-svc.rustfs.svc.cluster.local:9000
gateway:
  image:
    tag: ${AGENTZ_VERSION}
  config:
    agentImage: public.ecr.aws/k9v9d5v2/agentz/agent:${AGENTZ_VERSION}
    externalJWTIssuer: https://${AGENTZ_HOST}
    allowedWebOrigins:
    - https://${AGENTZ_HOST}
    skillsS3Endpoint: http://rustfs-svc.rustfs.svc.cluster.local:9000
observer:
  image:
    tag: ${AGENTZ_VERSION}
  config:
    kubearmorRelayAddr: kubearmor.kubearmor.svc.cluster.local:32767
web:
  image:
    tag: ${AGENTZ_VERSION}
  env:
    betterAuthURL: https://${AGENTZ_HOST}
    gatewayBaseURL: https://${AGENTZ_HOST}
    enableEmailPasswordAuth: true
    emailPasswordAuthAllowedUser: ${ADMIN_EMAIL}
    organizationAssetsS3Endpoint: https://${S3_HOST}
    organizationAssetsS3Region: us-east-1
    organizationAssetsS3Bucket: agentz-assets
    organizationAssetsPublicBaseURL: https://${S3_HOST}/agentz-assets
    organizationAssetsS3ForcePathStyle: true
ingress:
  enabled: true
  className: traefik
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
  hosts:
  - host: ${AGENTZ_HOST}
  tls:
  - hosts: ["${AGENTZ_HOST}"]
    secretName: agentz-tls
YAML
```

```bash
helm upgrade --install agentz /root/agentz/deploy/helm \
  --namespace agentz-system -f agentz-values.yaml \
  --wait --timeout 10m

kubectl wait clustersecretstore/agentz-inference --for=condition=Ready --timeout=120s
kubectl wait certificate/agentz-tls -n agentz-system --for=condition=Ready --timeout=300s
kubectl get deployments,pods,ingress -n agentz-system
```

Open `https://agentz.example.com/signup` and register with `ADMIN_EMAIL`.
