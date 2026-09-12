import { ArrowUp, Bot, Database, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildConversationTurn,
  type ConversationContext,
  type ConversationTurn,
  type DisasterTimelineContext,
} from "../lib/conversationEngine";
import type { InvestigationBrief } from "../lib/investigationEngine";
import type { CatalogScene, InvestigationRequest } from "../lib/types";
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
  | { id: string; role: "assistant"; turn: ConversationTurn };

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
  const sequence = useRef(0);

  useEffect(() => {
    setMessages([messageForContext(context)]);
    setDraft("");
  }, [contextKey]);

  const latestAssistant = [...messages].reverse().find((message): message is Extract<ChatMessage, { role: "assistant" }> => message.role === "assistant");

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || disabled) return;
    sequence.current += 1;
    const turn = buildConversationTurn(context, question);
    setMessages((previous) => [
      ...previous,
      { id: makeMessageId(sequence.current), role: "user", text: question },
      { id: makeMessageId(sequence.current + 1), role: "assistant", turn },
    ]);
    setDraft("");
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
        {onUseQuestion && draft.trim() && (
          <button className="conversation-panel__use-question" type="button" onClick={() => onUseQuestion(draft.trim())} disabled={disabled}>
            Use this question in investigation
          </button>
        )}
      </form>
    </section>
  );
}
