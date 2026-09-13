import type {
  ConversationClaimStatus,
  EvidenceBoundModelRequest,
} from "../lib/conversationEngine";

/**
 * Browser-to-server contract for the optional intelligence-chat service.
 *
 * Deliberately omit `systemInstruction` and `responseRequirements` here: the
 * server owns its model configuration and must enforce the evidence boundary.
 * This module never contains or forwards a provider API key.
 */
export type IntelligenceChatRequest = Pick<EvidenceBoundModelRequest, "question" | "evidence">;

export type IntelligenceChatResponse = {
  answer: string;
  model?: string;
  provider?: string;
  claimStatus?: ConversationClaimStatus;
  generatedAt?: string;
};

export type IntelligenceChatOptions = {
  /** Cancels the request when the conversation view is replaced or unmounted. */
  signal?: AbortSignal;
  /** Defaults to 20 seconds and is capped to keep the UI responsive. */
  timeoutMs?: number;
  /** Supabase access token for the protected server-side model route. */
  accessToken?: string | null;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_ANSWER_LENGTH = 20_000;
const MAX_METADATA_LENGTH = 240;

const configuredBackend = import.meta.env.VITE_BACKEND_BASE_URL?.trim().replace(/\/+$/, "");
const claimStatuses: ReadonlySet<ConversationClaimStatus> = new Set([
  "verified-geometry",
  "evidence-bounded",
  "withheld-pending-processing",
  "not-available",
]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown, maximumLength = MAX_METADATA_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= maximumLength ? text : undefined;
}

function parseResponse(payload: unknown): IntelligenceChatResponse | null {
  if (!isRecord(payload)) return null;

  const answer = optionalText(payload.answer, MAX_ANSWER_LENGTH);
  if (!answer) return null;

  const rawClaimStatus = payload.claimStatus;
  if (rawClaimStatus !== undefined && (typeof rawClaimStatus !== "string" || !claimStatuses.has(rawClaimStatus as ConversationClaimStatus))) {
    return null;
  }

  return {
    answer,
    model: optionalText(payload.model),
    provider: optionalText(payload.provider),
    claimStatus: rawClaimStatus as ConversationClaimStatus | undefined,
    generatedAt: optionalText(payload.generatedAt),
  };
}

function timeoutFor(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs as number)));
}

/** Returns whether this build has an optional intelligence backend configured. */
export function isIntelligenceChatConfigured(): boolean {
  return Boolean(configuredBackend);
}

/**
 * Attempts an evidence-bounded server-side answer.
 *
 * `null` is an expected fallback signal: it covers an unconfigured endpoint,
 * cancellation, timeout, failed HTTP response, invalid JSON, and malformed
 * payload. Callers should render the deterministic conversation-engine answer
 * when this function returns `null`.
 */
export async function requestIntelligenceChat(
  request: EvidenceBoundModelRequest,
  options: IntelligenceChatOptions = {},
): Promise<IntelligenceChatResponse | null> {
  const accessToken = options.accessToken?.trim();
  if (!configuredBackend || !accessToken || options.signal?.aborted) return null;

  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  options.signal?.addEventListener("abort", abortRequest, { once: true });
  const timeout = window.setTimeout(abortRequest, timeoutFor(options.timeoutMs));

  const payload: IntelligenceChatRequest = {
    question: request.question,
    evidence: request.evidence,
  };

  try {
    const response = await fetch(`${configuredBackend}/api/intelligence/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) return null;

    let responsePayload: unknown;
    try {
      responsePayload = await response.json();
    } catch {
      return null;
    }
    return parseResponse(responsePayload);
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortRequest);
  }
}
