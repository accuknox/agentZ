import { Result, ResultAsync, err, ok, type Result as ResultType } from 'neverthrow';
import { isAgentStatusChunk, type AgentStatusChunk } from '$lib/agent-status';
import { toError } from '$lib/errors';

type AgentStatusStreamOptions = {
	onChunk: (chunk: AgentStatusChunk) => void;
};

function parseSseLine(line: string): ResultType<AgentStatusChunk | null, Error> {
	if (!line.startsWith('data:')) {
		return ok(null);
	}

	const payload = line.slice(5).trim();
	if (!payload) {
		return ok(null);
	}

	return Result.fromThrowable(JSON.parse, (cause) =>
		toError(cause, 'Unable to parse agent status frame')
	)(payload).andThen((value) => {
		if (isAgentStatusChunk(value)) {
			return ok(value);
		}

		return err(new Error('Agent status frame has an invalid shape'));
	});
}

async function readStream(
	body: ReadableStream<Uint8Array>,
	onChunk: (chunk: AgentStatusChunk) => void
): Promise<ResultType<void, Error>> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	try {
		while (true) {
			const read = await ResultAsync.fromPromise(reader.read(), (cause) =>
				toError(cause, 'Unable to read agent status stream')
			);

			if (read.isErr()) {
				return err(read.error);
			}

			if (read.value.done) {
				return ok(undefined);
			}

			buffer += decoder.decode(read.value.value, {
				stream: true
			});

			let frameEnd = buffer.indexOf('\n\n');
			while (frameEnd !== -1) {
				const frame = buffer.slice(0, frameEnd);
				buffer = buffer.slice(frameEnd + 2);

				for (const line of frame.split('\n')) {
					const parsed = parseSseLine(line);
					if (parsed.isErr()) {
						return err(parsed.error);
					}

					if (parsed.value) {
						onChunk(parsed.value);
					}
				}

				frameEnd = buffer.indexOf('\n\n');
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export class AgentStatusStream {
	#abortController: AbortController | null = null;
	#options: AgentStatusStreamOptions;

	constructor(options: AgentStatusStreamOptions) {
		this.#options = options;
	}

	async start(sessionIds: string[]): Promise<ResultType<void, Error>> {
		this.abort();

		const abortController = new AbortController();
		this.#abortController = abortController;

		const response = await ResultAsync.fromPromise(
			fetch('/agents/status', {
				body: JSON.stringify({
					sessionIds
				}),
				headers: {
					'Content-Type': 'application/json'
				},
				method: 'POST',
				signal: abortController.signal
			}),
			(cause) => toError(cause, 'Unable to start agent status stream')
		);

		if (response.isErr()) {
			return err(response.error);
		}

		if (!response.value.ok) {
			return err(new Error(`Unable to start agent status stream (${response.value.status})`));
		}

		if (!response.value.body) {
			return err(new Error('Agent status stream response body is missing'));
		}

		const read = await readStream(response.value.body, this.#options.onChunk);
		if (this.#abortController === abortController) {
			this.#abortController = null;
		}

		return read;
	}

	abort() {
		this.#abortController?.abort();
		this.#abortController = null;
	}
}
