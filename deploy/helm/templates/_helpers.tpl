{{- define "agentz.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" -}}
{{- end -}}

{{- define "agentz.labels" -}}
helm.sh/chart: {{ include "agentz.chart" . }}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: agentz
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "agentz.gatewayFullname" -}}
{{- if .Values.gateway.fullnameOverride -}}
{{- .Values.gateway.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (default "gateway" .Values.gateway.nameOverride) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "agentz.webFullname" -}}
{{- if .Values.web.fullnameOverride -}}
{{- .Values.web.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (default "web" .Values.web.nameOverride) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
