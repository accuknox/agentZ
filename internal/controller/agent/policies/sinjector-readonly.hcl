path "{{ .DataPath }}" {
  capabilities = ["read", "update"]
}

path "{{ .MetadataPath }}" {
  capabilities = ["read", "list"]
}
