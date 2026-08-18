{{- define "manager.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
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

{{- define "manager.inferenceExternalSecretsServiceAccountName" -}}
{{- default (printf "%s-inference-external-secrets" .Release.Name) .Values.inference.externalSecrets.serviceAccount.name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
