export function firstSearchParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value[0]
  }

  return value
}
