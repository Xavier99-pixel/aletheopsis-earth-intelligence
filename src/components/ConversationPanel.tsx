import { ArrowUp, Bot, Database, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildConversationTurn,
  createEvidenceBoundModelRequest,
  type ConversationContext,
  type ConversationTurn,
  type DisasterTimelineContext,
} from "../lib/conversationEngine";
import type { InvestigationBrief } from "../lib/investigationEngine";
import type { CatalogScene, InvestigationRequest } from "../lib/types";
import { authConfigured, getAuthenticatedAccessToken } from "../services/auth";
import { isIntelligenceChatConfigured, requestIntelligenceChat, type IntelligenceChatResponse } from "../services/intelligenceChat";
import type { RainfallOutlook } from "../services/weather";

type ConversationPanelProps = {
  request: InvestigationRequest;
  brief: InvestigationBrief | null;
  scenes?: readonly CatalogScene[];
  rainfallOutlook?: RainfallOutlook | null;
  timeline?: DisasterTimelineContext | null;
  /** Lets the host put a suggested chat question into its main investigation workflow. */
  onUseQuestion?: (question: string) => void;
  disabled?: boolean;
};

type ChatMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; turn: ConversationTurn }
  | { id: string; role: "hosted"; response: IntelligenceChatResponse };

function makeMessageId(counter: number) {
  return `conversation-${Date.now()}-${counter}`;
}

function messageForContext(context: ConversationContext): ChatMessage {
  return {
    id: "conversation-initial",
    role: "assistant",
    turn: buildConversationTurn(context, "Summarise the current investigation."),
  };
}

function sourceIcon(kind: ConversationTurn["sources"][number]["kind"]) {
  if (kind === "withheld") return <ShieldCheck size={13} />;
  return <Database size={13} />;
}

/**
 * A small, self-contained ChatGPT-style surface. It renders deterministic
 * evidence-bound answers today, while a host may later pass the same evidence
 * pack to a server-side model through `createEvidenceBoundModelRequest`.
 */
export function ConversationPanel({
  request,
  brief,
  scenes,
  rainfallOutlook,
  timeline,
  onUseQuestion,
  disabled = false,
}: ConversationPanelProps) {
  const context = useMemo<ConversationContext>(() => ({
    request,
    brief,
    scenes,
    rainfallOutlook,
    timeline,
  }), [brief, rainfallOutlook, request, scenes, timeline]);
  const contextKey = `${request.question}|${request.aoi.name}|${request.aoi.bbox.join(",")}|${request.startDate}|${request.endDate}|${request.sensors.join(",")}|${request.tools.join(",")}|${brief?.generatedAt ?? "no-brief"}|${brief?.question ?? ""}|${rainfallOutlook?.fetchedAt ?? "no-weather"}|${timeline?.events.map((event) => `${event.id ?? event.title}:${event.date}`).join("|") ?? "no-timeline"}`;
  const [messages, setMessages] = useState<ChatMessage[]>(() => [messageForContext(context)]);
  const [draft, setDraft] = useState("");
  const [hostedEnabled, setHostedEnabled] = useState(false);
  const [hostedStatus, setHostedStatus] = useState<"ready" | "working" | "unavailable">("ready");
  const sequence = useRef(0);
  const activeContextKey = useRef(contextKey);
  const hostedRequest = useRef<AbortController | null>(null);
  // The service only accepts a verified Supabase session, so do not advertise
  // the paid hosted path inside the intentionally unauthenticated demo mode.
  const hostedAvailable = authConfigured && isIntelligenceChatConfigured();

  useEffect(() => {
    hostedRequest.current?.abort();
    hostedRequest.current = null;
    activeContextKey.current = contextKey;
    setMessages([messageForContext(context)]);
    setDraft("");
    setHostedStatus("ready");
  }, [contextKey]);

  useEffect(() => () => hostedRequest.current?.abort(), []);

  const latestAssistant = [...messages].reverse().find((message): message is Extract<ChatMessage, { role: "assistant" }> => message.role === "assistant");

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || disabled) return;
    sequence.current += 3;
    const turn = buildConversationTurn(context, question);
    const currentSequence = sequence.current;
    const requestedContextKey = contextKey;
    setMessages((previous) => [
      ...previous,
      { id: makeMessageId(currentSequence), role: "user", text: question },
      { id: makeMessageId(currentSequence + 1), role: "assistant", turn },
    ]);
    setDraft("");

    if (!hostedAvailable || !hostedEnabled) return;
    hostedRequest.current?.abort();
    const controller = new AbortController();
    hostedRequest.current = controller;
    setHostedStatus("working");
    const modelRequest = createEvidenceBoundModelRequest(context, question);
    void (async () => {
      const accessToken = await getAuthenticatedAccessToken();
      const response = await requestIntelligenceChat(modelRequest, { accessToken, signal: controller.signal });
      if (controller.signal.aborted || activeContextKey.current !== requestedContextKey) return;
      if (!response) {
        if (hostedRequest.current === controller) hostedRequest.current = null;
        setHostedStatus("unavailable");
        return;
      }
      setMessages((previous) => [
        ...previous,
        { id: makeMessageId(currentSequence + 2), role: "hosted", response },
      ]);
      setHostedStatus("ready");
      if (hostedRequest.current === controller) hostedRequest.current = null;
    })();
  }

  function useSuggestedQuestion(question: string) {
    setDraft(question);
  }

  return (
    <section className="conversation-panel" aria-label="Evidence-bounded intelligence conversation">
      <header className="conversation-panel__header">
        <div className="conversation-panel__identity"><Bot size={18} /><span>Intelligence conversation</span></div>
        <span className="conversation-panel__mode"><ShieldCheck size={13} /> Evidence-bounded</span>
      </header>

      <div className="conversation-panel__messages" aria-live="polite">
        {messages.map((message) => {
          if (message.role === "user") {
            return <div className="conversation-message conversation-message--user" key={message.id}>{message.text}</div>;
          }
          if (message.role === "hosted") {
            const { response } = message;
            return (
              <article className="conversation-message conversation-message--hosted" key={message.id}>
                <div className="conversation-message__heading"><Bot size={14} /><span>Hosted evidence synthesis</span></div>
                <p>{response.answer}</p>
                <small className="conversation-message__boundary">
                  {response.provider ?? "Hosted model"}{response.model ? ` · ${response.model}` : ""} · claim status remains {response.claimStatus ?? "evidence-bounded"}.
                </small>
              </article>
            );
          }
          const { turn } = message;
          return (
            <article className="conversation-message conversation-message--assistant" key={message.id}>
              <div className="conversation-message__heading"><Sparkles size={14} /><span>{turn.claimLabel}</span></div>
              <p>{turn.answer}</p>
              <small className="conversation-message__boundary">{turn.explanation}</small>

              {(turn.calculations.length > 0 || turn.sources.length > 0) && (
                <details className="conversation-message__evidence">
                  <summary>Evidence and calculations used</summary>
                  {turn.calculations.length > 0 && (
                    <div className="conversation-evidence-group">
                      <strong>Calculations</strong>
                      {turn.calculations.map((calculation) => (
                        <div className="conversation-evidence-row" key={`${calculation.label}-${calculation.value}`}>
                          <span>{calculation.label}</span><b>{calculation.value}</b><small>{calculation.method}</small>
                        </div>
                      ))}
                    </div>
                  )}
                  {turn.sources.length > 0 && (
                    <div className="conversation-evidence-group">
                      <strong>Sources</strong>
                      {turn.sources.map((source) => (
                        <div className="conversation-evidence-row" key={source.id}>
                          <span>{sourceIcon(source.kind)} {source.label}</span>
                          {source.href ? <a href={source.href} target="_blank" rel="noreferrer">Open source</a> : <b>Context</b>}
                          <small>{source.detail}</small>
                        </div>
                      ))}
                    </div>
                  )}
                </details>
              )}
            </article>
          );
        })}
      </div>

      {latestAssistant && latestAssistant.turn.suggestedFollowUps.length > 0 && (
        <div className="conversation-panel__suggestions" aria-label="Suggested follow-up questions">
          {latestAssistant.turn.suggestedFollowUps.map((question) => (
            <button type="button" key={question} onClick={() => useSuggestedQuestion(question)} disabled={disabled}>{question}</button>
          ))}
        </div>
      )}

      <form className="conversation-panel__composer" onSubmit={submit}>
        <label htmlFor="intelligence-follow-up">Ask a follow-up about the current evidence</label>
        {hostedAvailable && (
          <label className="conversation-panel__hosted-toggle">
            <input type="checkbox" checked={hostedEnabled} onChange={(event) => setHostedEnabled(event.target.checked)} disabled={disabled || hostedStatus === "working"} />
            <span>Use hosted AI synthesis</span>
            <small>Shares this question and displayed evidence with the secured analysis service.</small>
          </label>
        )}
        <div>
          <textarea
            id="intelligence-follow-up"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask about measurements, available scenes, weather context, incidents, or the evidence route…"
            rows={2}
            disabled={disabled}
          />
          <button type="submit" aria-label="Send follow-up question" disabled={disabled || !draft.trim()}><ArrowUp size={17} /></button>
        </div>
        {hostedAvailable && hostedStatus === "working" && <small className="conversation-panel__hosted-status">Preparing evidence-bounded synthesis…</small>}
        {hostedAvailable && hostedStatus === "unavailable" && <small className="conversation-panel__hosted-status">Hosted synthesis is unavailable; the local evidence response remains the active answer.</small>}
        {onUseQuestion && draft.trim() && (
          <button className="conversation-panel__use-question" type="button" onClick={() => onUseQuestion(draft.trim())} disabled={disabled}>
            Use this question in investigation
          </button>
        )}
      </form>
    </section>
  );
}
