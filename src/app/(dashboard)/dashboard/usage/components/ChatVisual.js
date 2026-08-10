"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import {
  isTruncated,
  truncatedSizeKB,
  normalizeMessages,
  normalizeResponse,
  formatToolArgs,
} from "./chatVisualUtils";

const EXPAND_THRESHOLD = 600;

/** Text block with Show more/less for long content. */
function ExpandableText({ text, className = "" }) {
  const [expanded, setExpanded] = useState(false);
  const long = typeof text === "string" && text.length > EXPAND_THRESHOLD;
  const shown = long && !expanded ? `${text.slice(0, EXPAND_THRESHOLD)}…` : text;
  return (
    <div className={className}>
      <div className="whitespace-pre-wrap break-words">{shown}</div>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs font-medium text-primary hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

ExpandableText.propTypes = {
  text: PropTypes.string.isRequired,
  className: PropTypes.string,
};

/** Collapsible monospace block (tool args/results). */
function CodeBlock({ label, value, tone }) {
  const [open, setOpen] = useState(false);
  const text = typeof value === "string" ? value : formatToolArgs(value);
  if (!text) return null;
  const toneCls =
    tone === "emerald"
      ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
      : "border-indigo-500/20 bg-indigo-500/5 text-indigo-700 dark:text-indigo-300";
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${toneCls}`}
      >
        <span className="material-symbols-outlined text-[13px]">{open ? "expand_less" : "expand_more"}</span>
        {label}
      </button>
      {open && (
        <pre className="mt-1.5 max-h-[260px] overflow-auto rounded-lg border border-black/5 bg-black/5 p-2.5 font-mono text-[11px] leading-4 text-text-main custom-scrollbar dark:border-white/5 dark:bg-white/5">
          {text}
        </pre>
      )}
    </div>
  );
}

CodeBlock.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
  tone: PropTypes.oneOf(["indigo", "emerald"]),
};

/** Notice for fields truncated at capture time. */
function TruncatedNotice({ label, value }) {
  return (
    <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300">
      <div className="flex items-center gap-1.5 font-medium">
        <span className="material-symbols-outlined text-[15px]">cut</span>
        {label} was truncated at capture time (~{truncatedSizeKB(value)} KB original).
        Raise Settings → Observability capture size for full content on new requests.
      </div>
      {value?._preview && (
        <pre className="mt-2 overflow-x-auto rounded border border-amber-500/20 bg-black/5 p-2 font-mono text-[10px] text-amber-900 dark:bg-white/5 dark:text-amber-200">
          {value._preview}
        </pre>
      )}
    </div>
  );
}

TruncatedNotice.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.object,
};

function RoleLabel({ children }) {
  return (
    <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
      {children}
    </div>
  );
}

RoleLabel.propTypes = { children: PropTypes.node.isRequired };

/** One chat item — text bubble, tool call/result chip, image placeholder. */
function ChatItem({ item }) {
  const role = item.role === "assistant" ? "Assistant" : item.role === "system" ? "System" : "User";

  if (item.kind === "image") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%]">
          <RoleLabel>{role}</RoleLabel>
          <div className="flex items-center gap-1.5 rounded-lg border border-black/10 bg-black/[0.03] px-2.5 py-1.5 text-xs text-text-muted dark:border-white/10 dark:bg-white/[0.05]">
            <span className="material-symbols-outlined text-[15px]">image</span>
            image attachment
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === "tool_call") {
    return (
      <div className="max-w-[92%] rounded-lg border border-indigo-500/20 bg-indigo-500/[0.06] px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="material-symbols-outlined text-[15px] text-indigo-500">construction</span>
          <span className="font-semibold text-indigo-600 dark:text-indigo-300">Tool call</span>
          <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-[11px] text-text-main dark:bg-white/10">
            {item.name}
          </code>
        </div>
        <CodeBlock label="arguments" value={item.args} tone="indigo" />
      </div>
    );
  }

  if (item.kind === "tool_result") {
    return (
      <div className="max-w-[92%] rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="material-symbols-outlined text-[15px] text-emerald-500">assignment</span>
          <span className="font-semibold text-emerald-600 dark:text-emerald-300">Tool result</span>
          <code className="max-w-[220px] truncate rounded bg-black/5 px-1.5 py-0.5 font-mono text-[11px] text-text-main dark:bg-white/10">
            {item.name}
          </code>
        </div>
        <CodeBlock label="result" value={item.result} tone="emerald" />
      </div>
    );
  }

  // Text message
  if (item.role === "system") {
    return (
      <div className="rounded-lg border border-black/10 bg-black/[0.03] px-3 py-2 dark:border-white/10 dark:bg-white/[0.04]">
        <RoleLabel>System</RoleLabel>
        <ExpandableText text={item.text} className="text-xs leading-5 text-text-muted" />
      </div>
    );
  }

  const isUser = item.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={isUser ? "max-w-[85%]" : "max-w-[92%]"}>
        <div className={isUser ? "text-right" : ""}>
          <RoleLabel>{role}</RoleLabel>
        </div>
        <div
          className={
            isUser
              ? "rounded-2xl rounded-tr-sm bg-primary/10 px-3.5 py-2.5 text-sm text-text-main"
              : "rounded-2xl rounded-tl-sm bg-black/[0.04] px-3.5 py-2.5 text-sm text-text-main dark:bg-white/[0.06]"
          }
        >
          <ExpandableText text={item.text} className="leading-6" />
        </div>
      </div>
    </div>
  );
}

ChatItem.propTypes = {
  item: PropTypes.shape({
    kind: PropTypes.string.isRequired,
    role: PropTypes.string,
    name: PropTypes.string,
    text: PropTypes.string,
    args: PropTypes.any,
    result: PropTypes.any,
  }).isRequired,
};

/**
 * ChatVisual — renders a requestDetails record as a conversation:
 * request messages (text bubbles + tool calls/results) followed by the
 * captured response (thinking, content, or error).
 */
export default function ChatVisual({ detail }) {
  const requestTruncated = isTruncated(detail?.request);
  const responseTruncated = isTruncated(detail?.response);

  const items = useMemo(
    () => (requestTruncated ? [] : normalizeMessages(detail?.request)),
    [detail?.request, requestTruncated],
  );

  const resp = useMemo(
    () => normalizeResponse(responseTruncated ? null : detail?.response),
    [detail?.response, responseTruncated],
  );

  const toolCount = useMemo(() => {
    const tools = detail?.request?.tools;
    return Array.isArray(tools) ? tools.length : 0;
  }, [detail?.request]);

  const streamIncomplete =
    !responseTruncated &&
    (resp.content === "[Streaming in progress...]" ||
      detail?.providerResponse === "[Streaming - raw response not captured]");

  return (
    <div className="space-y-4" data-i18n-skip>
      {/* Conversation header */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <span className="flex items-center gap-1 font-semibold uppercase tracking-wide text-text-main">
          <span className="material-symbols-outlined text-[15px]">chat</span>
          Conversation
        </span>
        {!requestTruncated && <span>· {items.length} item{items.length === 1 ? "" : "s"}</span>}
        {toolCount > 0 && (
          <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 font-medium text-indigo-600 dark:text-indigo-300">
            {toolCount} tool definition{toolCount === 1 ? "" : "s"} available
          </span>
        )}
      </div>

      {/* Request side */}
      {requestTruncated ? (
        <TruncatedNotice label="Client request" value={detail?.request} />
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-black/5 bg-black/[0.02] px-3 py-4 text-center text-xs text-text-muted dark:border-white/5 dark:bg-white/[0.03]">
          No message content captured for this request (e.g. Responses-API or Gemini-format client).
          Check the Raw JSON tab for the stored body.
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {items.map((item, i) => (
            <ChatItem key={i} item={item} />
          ))}
        </div>
      )}

      {/* Response side */}
      <div className="border-t border-black/5 pt-4 dark:border-white/5">
        <div className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-text-main">
          <span className="material-symbols-outlined text-[15px]">smart_toy</span>
          Response
          {resp.finishReason && (
            <span className="ml-1 rounded-full bg-black/5 px-2 py-0.5 font-mono text-[10px] font-medium normal-case text-text-muted dark:bg-white/10">
              {resp.finishReason}
            </span>
          )}
        </div>

        {responseTruncated ? (
          <TruncatedNotice label="Client response" value={detail?.response} />
        ) : resp.error ? (
          <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-sm text-red-600 dark:text-red-300">
            <div className="flex items-center gap-1.5 font-semibold">
              <span className="material-symbols-outlined text-[16px]">error</span>
              Error{resp.error.status ? ` (${resp.error.status})` : ""}
            </div>
            <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-5">{resp.error.message}</div>
          </div>
        ) : streamIncomplete ? (
          <div className="rounded-lg border border-black/5 bg-black/[0.02] px-3 py-4 text-center text-xs text-text-muted dark:border-white/5 dark:bg-white/[0.03]">
            Stream did not complete — no final content was captured.
          </div>
        ) : (
          <div className="space-y-3">
            {resp.thinking && (
              <div>
                <h4 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                  <span className="material-symbols-outlined text-[14px]">psychology</span>
                  Thinking
                </h4>
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-800/50 dark:bg-amber-950/30">
                  <ExpandableText
                    text={typeof resp.thinking === "string" ? resp.thinking : formatToolArgs(resp.thinking)}
                    className="font-mono text-xs leading-5 text-amber-900 dark:text-amber-100"
                  />
                </div>
              </div>
            )}
            <div className="rounded-2xl rounded-tl-sm bg-black/[0.04] px-3.5 py-2.5 dark:bg-white/[0.06]">
              {resp.content ? (
                <ExpandableText text={resp.content} className="text-sm leading-6 text-text-main" />
              ) : (
                <span className="text-sm text-text-muted">[No content]</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

ChatVisual.propTypes = {
  detail: PropTypes.shape({
    request: PropTypes.any,
    response: PropTypes.any,
    providerResponse: PropTypes.any,
  }),
};
