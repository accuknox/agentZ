{{- define "manager.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "manager.browserImage" -}}
{{- if .Values.config.browserImage -}}
{{- .Values.config.browserImage -}}
{{- else if .Values.browser.image.digest -}}
{{- printf "%s@%s" .Values.browser.image.repository .Values.browser.image.digest -}}
{{- else -}}
{{- $tag := default (printf "v%s" .Chart.AppVersion) .Values.browser.image.tag -}}
{{- printf "%s:%s" .Values.browser.image.repository $tag -}}
{{- end -}}
{{- end -}}

{{- define "manager.browserSeccompProfile" -}}
{{- if .Values.config.browserSeccompProfile -}}
{{- .Values.config.browserSeccompProfile -}}
{{- else if .Values.browser.seccomp.enabled -}}
{{- printf "agentz/browser-%s.json" (.Files.Get "files/browser-seccomp.json" | sha256sum) -}}
{{- end -}}
{{- end -}}

{{- define "manager.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "manager.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "manager.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" -}}
{{- end -}}

{{- define "manager.labels" -}}
helm.sh/chart: {{ include "manager.chart" . }}
app.kubernetes.io/name: {{ include "manager.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: agentz
app.kubernetes.io/component: manager
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "manager.selectorLabels" -}}
app.kubernetes.io/name: {{ include "manager.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
control-plane: controller-manager
{{- end -}}

{{- define "manager.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (printf "%s" (include "manager.fullname" .)) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "manager.webhookSecretName" -}}
{{- default (printf "%s-webhook-server-cert" (include "manager.fullname" .)) .Values.certManager.webhookSecretName -}}
{{- end -}}

{{- define "manager.webhookSelfSignedIssuerName" -}}
{{- printf "%s-%s" .Release.Name .Values.certManager.issuerName | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "manager.webhookCAName" -}}
{{- printf "%s-webhook-ca" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "manager.webhookCAIssuerName" -}}
{{- printf "%s-webhook-ca-issuer" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "manager.webhookCertificateName" -}}
{{- printf "%s-%s" (include "manager.fullname" .) .Values.certManager.webhookCertificateName | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "manager.inferenceSecretStoreName" -}}
{{- default (printf "%s-inference" .Release.Name) .Values.inference.externalSecrets.storeName | trunc 63 | trimSuffix "-" -}}
{{- end -}}
