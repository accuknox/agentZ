# AgentZ mobile PoC

An Expo client for one AgentZ agent and one continuing conversation. It supports cloud and self-hosted servers through the same pairing flow. The APK contains no server address or account credentials.

## Connect

1. Open a general-purpose agent in the AgentZ web UI and choose **Connect phone**.
2. In the Android app, scan the QR or paste its connection link.
3. Compare the six-digit codes and approve the phone on the web.
4. Send messages, delegate research, or ask the agent to schedule a workflow.

The phone must be able to reach both the web server and its configured gateway. Use a trusted HTTPS certificate. HTTP is available for development and private network deployments. Push notifications and voice recording are outside this PoC; keyboard dictation works normally.

## Build

Use Java 21 and the Android SDK versions selected by Expo SDK 58. Install dependencies with Bun, then run:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run build:apk
```

The APK is produced at `android/app/build/outputs/apk/release/app-release.apk`. It includes the JavaScript bundle and supports ARM64 phones and x86-64 emulators. Native projects are generated from `app.json`; do not edit them. The local PoC build uses Expo's generated development signing key and is intended for sideloading.

Deploy the web database migration and the updated gateway with the web application. Rebuild and roll out the agent image when bundled tools change; existing runtimes need the new tool definitions to accept time zones. `BETTER_AUTH_URL` and `GATEWAY_BASE_URL` must be reachable from the phone. Generate the mobile client with `bun run gen:api` after changing `../openapi/base.yaml`.

## Behavior

- SQLite restores recent messages and drafts. Sending updates the transcript and composer immediately, then persists the outbox before network delivery. AgentZ's existing input queue supplies idempotent delivery and explicit retries.
- Streaming batches display updates; active replies also reconcile with the server to recover missed events. The third-party `ShimmerText` from `react-native-ai-animations/text` sweeps a highlight across the live activity text while the agent responds. Tool calls and step counters stay out of the transcript.
- History and status refreshes preserve newer streaming events. Server deletions also remove cached text, and cache writes run in order. Delivery confirmation fetches the canonical message directly when it falls outside recent history.
- Backgrounding closes the stream. Foregrounding refreshes history and reconnects. Server-side work continues while the app is closed.
- A pairing invitation expires after two minutes. The phone creates its own random secret; the server stores only its hash. Approval grants thirty days of access and issues two-minute gateway tokens.
- Gateway authorization checks the connection, current membership, agent UID, and conversation on every request. Streaming events are filtered to that conversation. Disconnect revokes future requests immediately; existing streams end no later than their token expiry.
- Schedules use AgentZ terminology and `cronstrue` descriptions instead of raw cron expressions. The same conversation is reused after pairing again. AgentZ and OpenCode own memory, compaction, subagents, and routine execution.

## Validation

Manual checks used an Android 11 software emulator and live Kubernetes agents. They covered native camera pairing, matching codes, approval, denial, expired invitations, revocation, conversation isolation, streaming research with sources, subagent interruption, question replies, command approvals, routine creation, dark mode, keyboard layout, drafts, and cached history. An offline message survived a forced restart and an APK upgrade, then was delivered exactly once when connectivity returned. A denied tool's held follow-up became explicitly retryable and resumed successfully. The cleanup pass also checked synthetic-text filtering, live part removal and cache eviction, exact-message isolation, and delayed-response deletion races.

The installed APK and HTTPS download have matching SHA-256 checksums. Go tests, vet, lint, and the web and mobile TypeScript checks pass. No tests were added to the patch. Physical phone performance remains to be measured.

## References

The agent avatar uses the supplied Zed v2 artwork unchanged as a tinted silhouette, with independent native eyes and Reanimated CSS motion adapted from its supplied playground. It uses no WebView, SVG renderer, or animated image. Colors come from `web/app/globals.css`; the mascot uses its chart palette, stable for each installation/workspace/agent identity. Idle, thinking, tool execution, approval waiting, and completion follow the live agent state. Sideways glances, winks, and a short hop on a welcome-screen tap give Zed a mischievous character. Reduced motion disables the animations.

The layout follows the [Grok Bot demo](https://x.ai/bot) and its [App Store screenshots](https://apps.apple.com/us/app/grok-bot/id6794501026): a small header, neutral assistant bubbles, contrasting user bubbles, and a bottom composer. AgentZ supplies the mascot and action colors. Native system typography avoids a font-loading gate. HeroUI Native supplies button interactions, FlashList supplies the message list, and Expo supplies camera, secure storage, SQLite, haptics, and streaming fetch.

The local `.ref/rakazo` checkout at `bdeb33b74aa11cc62a0877ecc7866684cb6310ad` informed optimistic input, echoed-message reconciliation, floating controls, and keyboard layout. The supplied dark Android screenshot is the primary visual reference.

The local `.ref/bluesky` checkout informed the stable conversation subscription and cached startup. `.ref/t3code` informed keeping tool calls out of the chat. These are architectural references; their code and licenses are not copied into the app. Generated clients come from this repository's OpenAPI source and the pinned OpenCode SDK.

The release uses Lucide's individual icon entry points and generated Zod Mini validators. Idle glances, winks, and completion hops play once and rest; only thinking and tool execution repeat. Unchanged transcript rows retain their references during reconciliation, so metadata updates do not rebuild the message list.
