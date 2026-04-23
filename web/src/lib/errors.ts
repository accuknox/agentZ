export function toError(value: unknown, message: string): Error {
	if (value instanceof Error) {
		return value;
	}

	return new Error(message, {
		cause: value
	});
}
