import "./global.css"
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from "react-native"
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import { Button } from "heroui-native/button"
import { ShimmerText } from "react-native-ai-animations/text"
import cronstrue from "cronstrue"
import { HeroUINativeProvider } from "heroui-native/provider"
import { FlashList, type FlashListRef } from "@shopify/flash-list"
import { CameraView, useCameraPermissions } from "expo-camera"
import { StatusBar } from "expo-status-bar"
import * as Haptics from "expo-haptics"
import Markdown from "react-native-markdown-display"
import ArrowUp from "lucide-react-native/icons/arrow-up"
import ChevronLeft from "lucide-react-native/icons/chevron-left"
import CalendarClock from "lucide-react-native/icons/calendar-clock"
import LinkIcon from "lucide-react-native/icons/link"
import MoreHorizontal from "lucide-react-native/icons/ellipsis"
import QrCode from "lucide-react-native/icons/qr-code"
import Square from "lucide-react-native/icons/square"
import WifiOff from "lucide-react-native/icons/wifi-off"
import X from "lucide-react-native/icons/x"
import {
  claimConnection,
  finishConnection,
  restoreConnection,
  AgentClient,
  type Connection,
  type Pairing,
} from "./client"
import { Conversation, type ChatMessage } from "./conversation"
import { Zed, type ZedPose } from "./Zed"
import { listAgentWorkflowSchedules } from "./gateway/sdk.gen"
import type { WorkflowSchedule } from "./gateway/types.gen"

// sRGB equivalents of the semantic tokens in web/app/globals.css.
const light = {
  background: "#ffffff",
  foreground: "#19191a",
  muted: "#737373",
  surface: "#f5f5f5",
  chrome: "#ffffff",
  border: "#e5e5e5",
  primary: "#433df3",
  primaryText: "#fafafa",
  mascot: "#433df3",
  user: "#f2f5ff",
  userText: "#19191a",
  destructive: "#cf001c",
  agentColors: ["#4ac885", "#4f39f6", "#ffb900", "#3276e4", "#ff2056"],
}
const dark = {
  background: "#19191a",
  foreground: "#fafafa",
  muted: "#a1a1a1",
  surface: "#262626",
  chrome: "#262626",
  border: "#282828",
  primary: "#8095ff",
  primaryText: "#19191a",
  mascot: "#8095ff",
  user: "#21232b",
  userText: "#fafafa",
  destructive: "#ff6568",
  agentColors: ["#6be5a4", "#50a2ff", "#ffd562", "#8e51ff", "#ff6a8e"],
}
type Palette = typeof light

export default function App() {
  const [connection, setConnection] = useState<Connection | null>()
  const [startupError, setStartupError] = useState("")
  const scheme = useColorScheme()
  const colors = scheme === "dark" ? dark : light
  useEffect(() => {
    void restoreConnection()
      .then(setConnection)
      .catch(() => {
        setStartupError("Your saved connection could not be opened. Connect again.")
        setConnection(null)
      })
  }, [])
  return (
    <GestureHandlerRootView style={styles.fill}>
      <SafeAreaProvider>
        <HeroUINativeProvider>
          <StatusBar style={scheme === "dark" ? "light" : "dark"} />
          {connection === undefined ? (
            <View style={[styles.loading, { backgroundColor: colors.background }]}>
              <Zed color={colors.mascot} size={70} pose="thinking" />
            </View>
          ) : connection ? (
            <Chat
              key={connection.connection.id}
              saved={connection}
              colors={colors}
              onDisconnect={() => setConnection(null)}
            />
          ) : (
            <Connect colors={colors} error={startupError} onConnect={setConnection} />
          )}
        </HeroUINativeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

function Connect({
  colors,
  error: initialError,
  onConnect,
}: {
  colors: Palette
  error: string
  onConnect: (connection: Connection) => void
}) {
  const [screen, setScreen] = useState<"welcome" | "scan" | "link" | "confirm">("welcome")
  const [permission, requestPermission] = useCameraPermissions()
  const [link, setLink] = useState("")
  const [pairing, setPairing] = useState<Pairing>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initialError)
  const scanning = useRef(false)
  const [torch, setTorch] = useState(false)
  const [greeting, setGreeting] = useState(false)

  useEffect(() => {
    if (!greeting) return
    const timer = setTimeout(() => setGreeting(false), 2200)
    return () => clearTimeout(timer)
  }, [greeting])

  async function connect(value: string) {
    if (scanning.current) return
    scanning.current = true
    setBusy(true)
    setError("")
    try {
      const request = await claimConnection(value)
      setPairing(request)
      setScreen("confirm")
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read this QR.")
    } finally {
      setBusy(false)
      scanning.current = false
    }
  }

  useEffect(() => {
    if (!pairing || screen !== "confirm") return
    let disposed = false
    let inFlight = false
    const interval = setInterval(() => {
      if (inFlight || disposed) return
      inFlight = true
      void finishConnection(pairing)
        .then((connection) => {
          if (!disposed && connection) onConnect(connection)
        })
        .catch((cause: Error) => {
          if (!disposed) {
            setError(cause.message)
            setPairing(undefined)
          }
        })
        .finally(() => {
          inFlight = false
        })
    }, 2000)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [pairing, screen, onConnect])

  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      if (screen === "welcome") return false
      setScreen("welcome")
      setPairing(undefined)
      setError("")
      return true
    })
    return () => listener.remove()
  }, [screen])

  async function scan() {
    const granted = permission?.granted || (await requestPermission()).granted
    if (!granted) {
      setError(
        "Camera access is off. Paste the connection link instead, or enable the camera in Settings."
      )
      setScreen("link")
      return
    }
    setError("")
    setScreen("scan")
  }

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]}>
      {screen !== "welcome" && (
        <View style={styles.connectHeader}>
          <Pressable
            accessibilityLabel="Back"
            onPress={() => {
              setScreen("welcome")
              setPairing(undefined)
              setError("")
            }}
            style={styles.iconHit}
          >
            <X color={colors.foreground} size={22} />
          </Pressable>
          <Text style={[styles.smallTitle, { color: colors.foreground }]}>
            {screen === "scan"
              ? "Connect your agent"
              : screen === "link"
                ? "Connection link"
                : "Confirm connection"}
          </Text>
          <View style={styles.iconHit} />
        </View>
      )}
      {screen === "welcome" && (
        <View style={styles.intro}>
          <View style={styles.welcome}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Say hello to Zed"
              onPress={() => {
                setGreeting(true)
                void Haptics.selectionAsync()
              }}
              style={styles.welcomeLogo}
            >
              <Zed color={colors.mascot} size={92} pose={greeting ? "done" : "idle"} />
            </Pressable>
            <Text style={[styles.wordmark, { color: colors.foreground }]}>AgentZ</Text>
            <Text style={[styles.welcomeDescription, { color: colors.muted }]}>
              Your agent, wherever you are.
            </Text>
          </View>
          <View style={styles.welcomeActions}>
            <Button
              onPress={() => void scan()}
              style={{ backgroundColor: colors.primary, borderRadius: 28 }}
              size="md"
            >
              <QrCode size={18} color={colors.primaryText} />
              <Text style={[styles.buttonText, { color: colors.primaryText }]}>Scan agent QR</Text>
            </Button>
            <Button
              variant="secondary"
              onPress={() => {
                setError("")
                setScreen("link")
              }}
              style={{ backgroundColor: colors.surface, borderRadius: 28 }}
              size="md"
            >
              <Text style={[styles.buttonText, { color: colors.foreground }]}>
                Use a connection link
              </Text>
            </Button>
            <Text style={[styles.welcomeFootnote, { color: colors.muted }]}>
              Open your agent on the web and choose Connect phone.
            </Text>
            {error ? (
              <Text accessibilityRole="alert" style={[styles.error, { color: colors.destructive }]}>
                {error}
              </Text>
            ) : null}
          </View>
        </View>
      )}
      {screen === "scan" && (
        <View style={styles.fill}>
          <View style={styles.camera}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              enableTorch={torch}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={busy ? undefined : ({ data }) => void connect(data)}
            />
            <View pointerEvents="none" style={styles.scanFrame} />
            {busy && <ActivityIndicator style={styles.cameraBusy} color="white" />}
          </View>
          <View style={styles.scanInstructions}>
            <Text style={[styles.body, { color: colors.foreground, textAlign: "center" }]}>
              Scan the QR on your AgentZ agent.
            </Text>
            <Text style={[styles.caption, { color: colors.muted, textAlign: "center" }]}>
              Your connection stays with your AgentZ installation.
            </Text>
            {error ? (
              <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
            ) : null}
            <Button variant="ghost" onPress={() => setTorch(!torch)}>
              <Text style={{ color: colors.foreground }}>
                Turn flashlight {torch ? "off" : "on"}
              </Text>
            </Button>
            <Button variant="ghost" onPress={() => setScreen("link")}>
              <Text style={{ color: colors.muted }}>Use a connection link</Text>
            </Button>
          </View>
        </View>
      )}
      {screen === "link" && (
        <KeyboardAvoidingView
          style={styles.linkForm}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <LinkIcon size={30} color={colors.muted} />
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
            Bring your agent along.
          </Text>
          <Text style={[styles.body, { color: colors.muted }]}>
            Paste the connection link from your agent&apos;s Connect phone window.
          </Text>
          <TextInput
            selectionColor={colors.primary}
            accessibilityLabel="Connection link"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://your-agentz/api/mobile/pairing/…"
            placeholderTextColor={colors.muted}
            value={link}
            onChangeText={setLink}
            style={[
              styles.linkInput,
              { backgroundColor: colors.surface, color: colors.foreground },
            ]}
            onSubmitEditing={() => void connect(link)}
          />
          {error ? (
            <Text accessibilityRole="alert" style={[styles.error, { color: colors.destructive }]}>
              {error}
            </Text>
          ) : null}
          <Button
            isDisabled={busy || !link.trim()}
            onPress={() => void connect(link)}
            style={{ backgroundColor: colors.primary, borderRadius: 24 }}
          >
            {busy ? (
              <ActivityIndicator color={colors.background} />
            ) : (
              <Text style={[styles.buttonText, { color: colors.primaryText }]}>Continue</Text>
            )}
          </Button>
        </KeyboardAvoidingView>
      )}
      {screen === "confirm" && (
        <View style={styles.confirm}>
          <View style={styles.confirmLogo}>
            <Zed color={colors.mascot} size={56} pose="waiting" />
          </View>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Check the code.</Text>
          <Text style={[styles.body, { textAlign: "center", color: colors.muted }]}>
            Match this code with the one on your web page, then approve your phone there.
          </Text>
          <Text selectable style={[styles.code, { color: colors.foreground }]}>
            {pairing?.request.code.slice(0, 3)} {pairing?.request.code.slice(3)}
          </Text>
          {pairing && (
            <>
              <Text style={[styles.smallTitle, { color: colors.foreground }]}>
                {pairing.request.agent_name}
              </Text>
              <Text style={[styles.caption, { color: colors.muted }]}>
                {new URL(pairing.origin).host}
              </Text>
              {pairing.origin.startsWith("http:") && (
                <Text style={[styles.caption, { color: colors.muted, textAlign: "center" }]}>
                  Development connection · HTTP
                </Text>
              )}
              <View style={styles.waiting}>
                <ActivityIndicator size="small" color={colors.muted} />
                <Text style={[styles.caption, { color: colors.muted }]}>Waiting for approval</Text>
              </View>
            </>
          )}
          {error ? (
            <>
              <Text accessibilityRole="alert" style={[styles.error, { color: colors.destructive }]}>
                {error}
              </Text>
              <Button
                variant="secondary"
                onPress={() => {
                  setError("")
                  setScreen("welcome")
                }}
              >
                Try again
              </Button>
            </>
          ) : null}
        </View>
      )}
    </SafeAreaView>
  )
}

function Chat({
  saved,
  colors: theme,
  onDisconnect,
}: {
  saved: Connection
  colors: Palette
  onDisconnect: () => void
}) {
  const colors = useMemo(() => {
    let hash = 0
    for (const character of `${saved.connection.origin}/${saved.connection.workspace_id}/${saved.connection.agent_name}`)
      hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0
    return {
      ...theme,
      mascot: theme.agentColors[hash % theme.agentColors.length] ?? theme.primary,
    }
  }, [saved.connection, theme])
  const [conversation] = useState(() => new Conversation(new AgentClient(saved)))
  const snapshot = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot)
  const [draft, setDraft] = useState("")
  const [details, setDetails] = useState(false)
  const [home, setHome] = useState(false)
  const [schedules, setSchedules] = useState<WorkflowSchedule[]>()
  const [scheduleError, setScheduleError] = useState("")
  const [actionError, setActionError] = useState("")
  const list = useRef<FlashListRef<ChatMessage>>(null)
  const saveDraft = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latestDraft = useRef("")
  const insets = useSafeAreaInsets()

  useEffect(() => {
    let disposed = false
    void conversation
      .start()
      .then(async () => {
        const text = await conversation.draft()
        if (!disposed) {
          setDraft(text)
          latestDraft.current = text
        }
      })
      .catch((cause: Error) => {
        if (!disposed) setActionError(cause.message)
      })
    return () => {
      disposed = true
      clearTimeout(saveDraft.current)
      void conversation.saveDraft(latestDraft.current)
      conversation.stop()
    }
  }, [conversation])

  useEffect(() => {
    if (!details) return
    let disposed = false
    void listAgentWorkflowSchedules({
      client: conversation.client.gateway,
      path: { agentName: saved.connection.agent_name },
    })
      .then((result) => {
        if (disposed) return
        if (result.error) {
          setScheduleError("Could not load schedules.")
          return
        }
        setSchedules(result.data.workflow_schedules)
      })
      .catch(() => {
        if (!disposed) setScheduleError("Could not load schedules.")
      })
    return () => {
      disposed = true
    }
  }, [details, conversation, saved.connection.agent_name])

  function send() {
    const text = latestDraft.current
    if (!text.trim()) return
    setActionError("")
    clearTimeout(saveDraft.current)
    try {
      setDraft("")
      latestDraft.current = ""
      conversation.send(text)
      requestAnimationFrame(() => list.current?.scrollToEnd({ animated: false }))
      void Haptics.selectionAsync()
    } catch (cause) {
      setDraft(text)
      latestDraft.current = text
      setActionError(cause instanceof Error ? cause.message : "Message could not be saved.")
    }
  }

  async function disconnect() {
    try {
      const revoked = await conversation.clear()
      onDisconnect()
      if (!revoked)
        Alert.alert(
          "Removed from this phone",
          "The server was unreachable. You can revoke this connection from AgentZ on the web."
        )
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not disconnect.")
    }
  }

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (home) return false
      Keyboard.dismiss()
      setHome(true)
      return true
    })
    return () => subscription.remove()
  }, [home])

  const hasDraft = draft.trim().length > 0
  const responding =
    snapshot.working ||
    (!snapshot.error && snapshot.messages.some((message) => message.pending && !message.failed))
  const activity = snapshot.working ? snapshot.activity : ""
  let pose: ZedPose = snapshot.messages.at(-1)?.role === "user" ? "idle" : "done"
  if (responding) pose = snapshot.working && snapshot.usingTools ? "working" : "thinking"
  if (snapshot.permissions.length || snapshot.questions.length) pose = "waiting"
  const transcript = useMemo(() => {
    const firstMessage = snapshot.messages[0]
    let date = ""
    if (firstMessage) {
      const created = new Date(firstMessage.created)
      const today = created.toDateString() === new Date().toDateString()
      date = new Intl.DateTimeFormat(undefined, {
        month: today ? undefined : "short",
        day: today ? undefined : "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(created)
      if (today) date = `Today ${date}`
    }
    return (
      <FlashList
        ref={list}
        data={snapshot.messages}
        initialScrollIndex={snapshot.messages.length ? snapshot.messages.length - 1 : undefined}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <MessageRow message={item} colors={colors} onRetry={conversation.retryMessage} />
        )}
        contentContainerStyle={styles.messages}
        maintainVisibleContentPosition={{
          autoscrollToBottomThreshold: 0.2,
          animateAutoScrollToBottom: false,
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={false}
        getItemType={(item) => item.role}
        ListFooterComponent={
          <View style={styles.responseIndicator} accessibilityLiveRegion="polite">
            {responding && !snapshot.permissions.length && !snapshot.questions.length && (
              <View style={styles.activityRow}>
                <Zed color={colors.mascot} size={28} pose={pose} animate={!home && !details} />
                <View style={styles.activityLabel}>
                  {!home && !details ? (
                    <ShimmerText
                      text={activity || "Thinking"}
                      activeColor={colors.foreground}
                      mutedColor={colors.muted}
                      textStyle={styles.activityText}
                    />
                  ) : (
                    <Text numberOfLines={1} style={[styles.activityText, { color: colors.muted }]}>
                      {activity || "Thinking"}
                    </Text>
                  )}
                </View>
              </View>
            )}
          </View>
        }
        ListHeaderComponent={
          date ? <Text style={[styles.date, { color: colors.muted }]}>{date}</Text> : null
        }
      />
    )
  }, [
    snapshot.messages,
    activity,
    snapshot.permissions.length,
    snapshot.questions.length,
    colors,
    conversation,
    pose,
    home,
    details,
    responding,
  ])
  const error = actionError || snapshot.error
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        style={[styles.fill, home && styles.hidden]}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={styles.chatHeader} pointerEvents="box-none">
          <Pressable
            accessibilityLabel="Back to your agent"
            onPress={() => {
              Keyboard.dismiss()
              setHome(true)
            }}
            style={[
              styles.headerButton,
              { backgroundColor: colors.chrome, borderColor: colors.border },
            ]}
          >
            <ChevronLeft color={colors.foreground} size={23} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Agent details and schedules"
            onPress={() => {
              Keyboard.dismiss()
              setScheduleError("")
              setSchedules(undefined)
              setDetails(true)
            }}
            style={[
              styles.agentHeader,
              { backgroundColor: colors.chrome, borderColor: colors.border },
            ]}
          >
            <Zed
              color={colors.mascot}
              size={30}
              pose={pose}
              animate={!home && !details && !responding}
            />
            <Text numberOfLines={1} style={[styles.agentName, { color: colors.foreground }]}>
              {saved.connection.agent_name}
            </Text>
          </Pressable>
          <View style={styles.fill} />
          <Pressable
            accessibilityLabel="Agent settings"
            style={[
              styles.headerButton,
              { backgroundColor: colors.chrome, borderColor: colors.border },
            ]}
            onPress={() => {
              Keyboard.dismiss()
              setScheduleError("")
              setSchedules(undefined)
              setDetails(true)
            }}
          >
            <MoreHorizontal size={23} color={colors.foreground} />
          </Pressable>
        </View>
        {error ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry connection"
            onPress={() => {
              setActionError("")
              void conversation.connect()
            }}
            style={[styles.connectionBanner, { backgroundColor: colors.surface }]}
          >
            <WifiOff size={13} color={colors.muted} />
            <Text numberOfLines={2} style={[styles.bannerText, { color: colors.muted }]}>
              {error}
            </Text>
            <Text style={[styles.caption, { color: colors.primary }]}>Retry</Text>
          </Pressable>
        ) : null}
        {transcript}
        {(snapshot.permissions.length > 0 || snapshot.questions.length > 0) && (
          <ScrollView style={styles.requests} keyboardShouldPersistTaps="handled">
            {snapshot.permissions.map((permission) => (
              <View
                key={permission.id}
                style={[styles.request, { backgroundColor: colors.surface }]}
              >
                <Text style={[styles.requestTitle, { color: colors.foreground }]}>
                  Your approval is needed
                </Text>
                <Text selectable style={[styles.caption, { color: colors.muted }]}>
                  {permission.permission}
                  {"\n"}
                  {permission.patterns.join("\n")}
                </Text>
                <View style={styles.requestActions}>
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() =>
                      void conversation
                        .answerPermission(permission.id, "reject")
                        .catch((cause: Error) => setActionError(cause.message))
                    }
                  >
                    Deny
                  </Button>
                  <Button
                    size="sm"
                    onPress={() =>
                      void conversation
                        .answerPermission(permission.id, "once")
                        .catch((cause: Error) => setActionError(cause.message))
                    }
                  >
                    Allow once
                  </Button>
                </View>
              </View>
            ))}
            {snapshot.questions.map((question) => (
              <Question
                key={question.id}
                request={question}
                colors={colors}
                onAnswer={(answers) =>
                  void conversation
                    .answerQuestion(question.id, answers)
                    .catch((cause: Error) => setActionError(cause.message))
                }
              />
            ))}
          </ScrollView>
        )}
        <View
          style={[
            styles.composerArea,
            {
              paddingBottom: Math.max(insets.bottom, 10),
              backgroundColor: colors.background,
            },
          ]}
        >
          <View
            style={[
              styles.composer,
              {
                borderColor: colors.border,
                backgroundColor: colors.chrome,
              },
            ]}
          >
            <TextInput
              selectionColor={colors.primary}
              accessibilityLabel="Message your agent"
              placeholder={`Ask ${saved.connection.agent_name}`}
              placeholderTextColor={colors.muted}
              value={draft}
              onChangeText={(text) => {
                setDraft(text)
                latestDraft.current = text
                clearTimeout(saveDraft.current)
                saveDraft.current = setTimeout(() => void conversation.saveDraft(text), 250)
              }}
              multiline
              maxLength={32000}
              style={[styles.composerInput, { color: colors.foreground }]}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={snapshot.working && !hasDraft ? "Stop task" : "Send message"}
              disabled={!snapshot.working && !hasDraft}
              onPress={() => {
                if (snapshot.working && !hasDraft) {
                  void conversation
                    .interrupt()
                    .catch((cause: Error) => setActionError(cause.message))
                  return
                }
                void send()
              }}
              style={[
                styles.send,
                {
                  backgroundColor: hasDraft || snapshot.working ? colors.primary : colors.border,
                },
              ]}
            >
              {snapshot.working && !hasDraft ? (
                <Square fill={colors.primaryText} color={colors.primaryText} size={12} />
              ) : (
                <ArrowUp
                  size={21}
                  strokeWidth={2.3}
                  color={hasDraft ? colors.primaryText : colors.muted}
                />
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
      {home && (
        <View style={styles.inbox}>
          <View style={styles.inboxHeader}>
            <Pressable
              accessibilityLabel="Agent settings"
              onPress={() => {
                setScheduleError("")
                setSchedules(undefined)
                setDetails(true)
              }}
              style={[
                styles.headerButton,
                { backgroundColor: colors.chrome, borderColor: colors.border },
              ]}
            >
              <Zed color={colors.mascot} size={30} animate={false} />
            </Pressable>
            <Text style={[styles.inboxTitle, { color: colors.foreground }]}>AgentZ</Text>
          </View>
          <Pressable
            accessibilityLabel="Open conversation"
            onPress={() => setHome(false)}
            style={styles.inboxAgent}
          >
            <Zed color={colors.mascot} size={50} pose={pose} animate={!details} />
            <View style={styles.fill}>
              <Text style={[styles.agentName, { color: colors.foreground }]}>
                {saved.connection.agent_name}
              </Text>
              <Text numberOfLines={1} style={[styles.caption, { color: colors.muted }]}>
                {snapshot.messages.at(-1)?.text ?? "Your conversation"}
              </Text>
            </View>
          </Pressable>
        </View>
      )}
      <Modal
        visible={details}
        transparent
        animationType="slide"
        onRequestClose={() => setDetails(false)}
      >
        <View style={styles.modal}>
          <Pressable
            style={styles.backdrop}
            accessibilityLabel="Close agent details"
            onPress={() => setDetails(false)}
          />
          <View
            style={[
              styles.sheet,
              {
                backgroundColor: colors.background,
                paddingBottom: Math.max(insets.bottom, 24),
              },
            ]}
          >
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
            <View style={styles.sheetHeader}>
              <Zed color={colors.mascot} size={48} pose={pose} />
              <Pressable
                accessibilityLabel="Close details"
                onPress={() => setDetails(false)}
                style={styles.iconHit}
              >
                <X size={20} color={colors.muted} />
              </Pressable>
            </View>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
              {saved.connection.agent_name}
            </Text>
            <Text style={[styles.caption, { color: colors.muted }]}>
              {new URL(saved.connection.origin).host}
            </Text>
            <View style={styles.schedulesHeading}>
              <CalendarClock size={15} color={colors.muted} />
              <Text style={[styles.smallTitle, { color: colors.foreground }]}>Schedules</Text>
            </View>
            <ScrollView style={styles.scheduleList}>
              {schedules === undefined && !scheduleError && (
                <ActivityIndicator color={colors.muted} />
              )}
              {schedules?.length === 0 && (
                <Text style={[styles.body, { color: colors.muted }]}>
                  Ask your agent to schedule a workflow.
                </Text>
              )}
              {schedules?.map((schedule) => (
                <View key={schedule.name} style={[styles.schedule, { borderColor: colors.border }]}>
                  <Text style={[styles.smallTitle, { color: colors.foreground }]}>
                    {schedule.name}
                  </Text>
                  <Text style={[styles.caption, { color: colors.muted }]}>
                    {cronstrue.toString(schedule.schedule, {
                      use24HourTimeFormat: true,
                      throwExceptionOnParseError: false,
                    })}
                    {" · "}
                    {schedule.time_zone ?? "UTC"}
                    {schedule.suspend ? " · Paused" : ""}
                  </Text>
                </View>
              ))}
              {scheduleError ? (
                <Text style={[styles.error, { color: colors.destructive }]}>{scheduleError}</Text>
              ) : null}
            </ScrollView>
            <Button
              variant="secondary"
              style={{ marginTop: 24, backgroundColor: colors.surface }}
              onPress={() =>
                Alert.alert(
                  "Disconnect your agent?",
                  "This removes saved messages and unsent text from this phone. Your conversation stays in AgentZ.",
                  [
                    { text: "Keep connection", style: "cancel" },
                    {
                      text: "Disconnect",
                      style: "destructive",
                      onPress: () => void disconnect(),
                    },
                  ]
                )
              }
            >
              <Text style={[styles.buttonText, { color: colors.foreground }]}>Disconnect</Text>
            </Button>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  )
}

const MessageRow = memo(function MessageRow({
  message,
  colors,
  onRetry,
}: {
  message: ChatMessage
  colors: Palette
  onRetry: (id: string) => Promise<void>
}) {
  const isUser = message.role === "user"
  const markdown = {
    body: {
      color: colors.foreground,
      fontSize: 17,
      lineHeight: 23,
      margin: 0,
    },
    paragraph: { marginTop: 0, marginBottom: 4 },
    link: { color: colors.primary },
    code_inline: {
      backgroundColor: colors.border,
      color: colors.foreground,
      fontSize: 13,
    },
    fence: {
      backgroundColor: colors.background,
      color: colors.foreground,
      borderColor: colors.border,
      borderRadius: 10,
      fontSize: 13,
    },
    table: { borderColor: colors.border },
    heading1: { fontSize: 23, lineHeight: 30, marginTop: 8, marginBottom: 8 },
    heading2: { fontSize: 20, lineHeight: 27, marginTop: 8, marginBottom: 8 },
  }
  if (!message.text) return null
  return (
    <View style={[styles.messageRow, isUser && styles.userRow]}>
      <View
        style={[
          styles.bubble,
          { backgroundColor: isUser ? colors.user : colors.surface },
          isUser && styles.userBubble,
        ]}
      >
        {isUser ? (
          <Text selectable style={[styles.messageText, { color: colors.userText }]}>
            {message.text}
          </Text>
        ) : (
          <Markdown
            style={markdown}
            onLinkPress={(url) => {
              try {
                const parsed = new URL(url)
                if (parsed.protocol === "https:" || parsed.protocol === "http:")
                  void Linking.openURL(url)
              } catch {
                /* Ignore invalid model-provided links. */
              }
              return false
            }}
          >
            {message.text}
          </Markdown>
        )}
      </View>
      {message.pending && message.failed && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry message"
          onPress={() => void onRetry(message.id)}
        >
          <Text style={[styles.delivery, { color: colors.primary }]}>Tap to retry</Text>
        </Pressable>
      )}
    </View>
  )
})

function Question({
  request,
  colors,
  onAnswer,
}: {
  request: import("@opencode-ai/sdk/v2").QuestionRequest
  colors: Palette
  onAnswer: (answers: string[][]) => void
}) {
  const [answers, setAnswers] = useState<string[][]>(request.questions.map(() => []))
  const [custom, setCustom] = useState<string[]>(request.questions.map(() => ""))
  return (
    <View style={[styles.request, { backgroundColor: colors.surface }]}>
      {request.questions.map((question, index) => (
        <View key={index} style={{ gap: 8 }}>
          <Text style={[styles.requestTitle, { color: colors.foreground }]}>
            {question.question}
          </Text>
          {question.options.map((option) => (
            <Pressable
              key={option.label}
              onPress={() =>
                setAnswers((current) =>
                  current.map((answer, item) => {
                    if (item !== index) return answer
                    if (!question.multiple) return [option.label]
                    if (answer.includes(option.label))
                      return answer.filter((label) => label !== option.label)
                    return [...answer, option.label]
                  })
                )
              }
              style={[
                styles.option,
                {
                  borderColor: answers[index]?.includes(option.label)
                    ? colors.primary
                    : colors.border,
                },
              ]}
            >
              <Text style={[styles.smallTitle, { color: colors.foreground }]}>{option.label}</Text>
              <Text style={[styles.caption, { color: colors.muted }]}>{option.description}</Text>
            </Pressable>
          ))}
          {question.custom !== false && (
            <TextInput
              selectionColor={colors.primary}
              placeholder="Your answer…"
              placeholderTextColor={colors.muted}
              value={custom[index]}
              onChangeText={(text) =>
                setCustom((current) =>
                  current.map((value, item) => (item === index ? text : value))
                )
              }
              style={[styles.option, { borderColor: colors.border, color: colors.foreground }]}
            />
          )}
        </View>
      ))}
      <Button
        style={{ marginTop: 12 }}
        isDisabled={answers.some((answer, index) => !answer.length && !custom[index]?.trim())}
        onPress={() =>
          onAnswer(
            answers.map((answer, index) =>
              custom[index]?.trim() ? [custom[index].trim()] : answer
            )
          )
        }
      >
        Reply
      </Button>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  intro: { flex: 1, justifyContent: "center" },
  welcome: {
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  welcomeLogo: { width: 92, height: 92, marginBottom: 24 },
  wordmark: {
    fontWeight: "600",
    fontSize: 32,
    letterSpacing: -1.6,
  },
  welcomeDescription: {
    fontSize: 16,
    lineHeight: 24,
    marginTop: 10,
  },
  welcomeActions: { padding: 24, gap: 10, width: "100%", maxWidth: 360, alignSelf: "center" },
  welcomeFootnote: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
    marginTop: 12,
    paddingHorizontal: 12,
  },
  buttonText: { fontWeight: "500", fontSize: 15 },
  connectHeader: {
    height: 56,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
  },
  iconHit: {
    width: 44,
    height: 44,
    justifyContent: "center",
    alignItems: "center",
  },
  smallTitle: { fontWeight: "500", fontSize: 14 },
  sectionTitle: {
    fontWeight: "600",
    fontSize: 27,
    lineHeight: 34,
    letterSpacing: -0.8,
  },
  body: { fontSize: 15, lineHeight: 23 },
  caption: { fontSize: 12, lineHeight: 18 },
  linkForm: { padding: 28, paddingTop: 60, gap: 20 },
  linkInput: {
    fontSize: 14,
    borderRadius: 16,
    padding: 17,
    minHeight: 56,
  },
  error: {
    fontSize: 13,
    lineHeight: 20,
    textAlign: "center",
    marginVertical: 8,
  },
  camera: {
    flex: 1,
    margin: 18,
    borderRadius: 28,
    overflow: "hidden",
    backgroundColor: dark.background,
    justifyContent: "center",
    alignItems: "center",
  },
  scanFrame: {
    width: 230,
    height: 230,
    borderWidth: 2,
    borderColor: "white",
    borderRadius: 22,
  },
  cameraBusy: { position: "absolute" },
  scanInstructions: { padding: 24, gap: 10 },
  confirm: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 12,
  },
  confirmLogo: { width: 56, height: 56, marginBottom: 18 },
  code: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 43,
    letterSpacing: 5,
    marginVertical: 28,
  },
  waiting: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    marginTop: 30,
  },
  hidden: { display: "none" },
  chatHeader: {
    position: "absolute",
    top: 7,
    left: 16,
    right: 16,
    zIndex: 2,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  agentHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    height: 44,
    paddingLeft: 10,
    paddingRight: 16,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: "67%",
  },
  agentName: { fontWeight: "500", fontSize: 17, flexShrink: 1 },
  inbox: { flex: 1, padding: 18 },
  inboxHeader: { flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 35 },
  inboxTitle: { fontSize: 23, fontWeight: "600" },
  inboxAgent: { flexDirection: "row", alignItems: "center", gap: 16, paddingVertical: 18 },
  connectionBanner: {
    marginTop: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    padding: 12,
  },
  bannerText: { fontSize: 12, flex: 1 },
  messages: { paddingHorizontal: 16, paddingTop: 70, paddingBottom: 12 },
  date: { textAlign: "center", fontSize: 12, marginVertical: 18 },
  messageRow: { alignItems: "flex-start", marginBottom: 8 },
  userRow: { alignItems: "flex-end", marginTop: 12, marginBottom: 12 },
  bubble: {
    maxWidth: "86%",
    borderRadius: 23,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userBubble: { maxWidth: "88%" },
  messageText: { fontSize: 17, lineHeight: 23 },
  delivery: { fontSize: 10, padding: 5 },
  composerArea: { paddingHorizontal: 18, paddingTop: 7 },
  composer: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 27,
    padding: 7,
    paddingLeft: 17,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  composerInput: {
    fontSize: 17,
    lineHeight: 23,
    minHeight: 34,
    maxHeight: 145,
    flex: 1,
    paddingTop: 5,
    paddingBottom: 5,
  },
  send: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  responseIndicator: { height: 48, justifyContent: "center", paddingLeft: 4 },
  activityRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  activityLabel: { flex: 1, overflow: "hidden", maxHeight: 24 },
  activityText: { fontSize: 17, lineHeight: 24 },
  modal: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#00000080",
  },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 26,
    maxHeight: "82%",
  },
  handle: {
    width: 34,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginTop: -14,
    marginBottom: 15,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  schedulesHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginTop: 28,
    marginBottom: 15,
  },
  scheduleList: { maxHeight: 250 },
  schedule: {
    paddingVertical: 13,
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  requests: { maxHeight: 260, flexGrow: 0, flexShrink: 1 },
  request: { margin: 12, borderRadius: 18, padding: 18, gap: 10 },
  requestTitle: {
    fontWeight: "500",
    fontSize: 15,
    lineHeight: 22,
  },
  requestActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
  option: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 3 },
})
