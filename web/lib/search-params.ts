export function firstSearchParam<T extends string>(value?: T | T[]) {
  if (Array.isArray(value)) {
    return value[0]
  }

  return value
}
