path "{{ .DataPath }}" {
  capabilities = ["read"]
}

path "{{ .MetadataPath }}" {
  capabilities = ["read", "list"]
}
