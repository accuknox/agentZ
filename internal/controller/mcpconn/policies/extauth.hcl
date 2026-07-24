path "{{ .MCPDataPath }}" {
  capabilities = ["read", "update"]
}

path "{{ .MCPMetadataPath }}" {
  capabilities = ["read", "list"]
}

path "{{ .InferenceDataPath }}" {
  capabilities = ["read", "update"]
}

path "{{ .InferenceMetadataPath }}" {
  capabilities = ["read", "list"]
}
