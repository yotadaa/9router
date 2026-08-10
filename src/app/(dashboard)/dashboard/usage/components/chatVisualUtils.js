/**
 * Pure helpers for rendering requestDetails records as a chat conversation.
 * Handles the two client message shapes stored in `request`:
 *  - OpenAI: { role, content: string | parts[], tool_calls?, tool_call_id? }
 *  - Claude: { role, content: [{type:"text"|"image"|"tool_use"|"tool_result"}] }
 * Also handles the truncation sentinel { _truncated, _originalSize, _preview }.
 */

export function isTruncated(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && value._truncated === true;
}

export function truncatedSizeKB(value) {
  const bytes = Number(value?._originalSize) || 0;
  return Math.round(bytes / 1024);
}

/** Safe JSON.parse — returns fallback on any failure. */
export function parseSafe(value, fallback = null) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Format tool arguments (string JSON or object) for display. */
export function formatToolArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") {
    const parsed = parseSafe(args, null);
    if (parsed != null) {
      try { return JSON.stringify(parsed, null, 2); } catch { /* fall through */ }
    }
    return args;
  }
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
}

/**
 * Flatten any message content shape to display text.
 * Handles: string, OpenAI parts [{type:"text"|"image_url"}],
 * Claude blocks [{type:"text"|"image"}], arbitrary objects.
 */
export function flattenContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part == null) return "";
        if (typeof part === "string") return part;
        switch (part.type) {
          case "text": return part.text || "";
          case "image":
          case "image_url": return "[image]";
          case "thinking": return part.thinking || "";
          case "tool_use": return `[tool_use: ${part.name || "?"}]`;
          case "tool_result": return flattenContent(part.content);
          default: return part.text || "";
        }
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    try { return JSON.stringify(content, null, 2); } catch { return String(content); }
  }
  return String(content);
}

/**
 * Normalize a stored request into a flat list of chat items.
 * Returns [{ kind: "text"|"tool_call"|"tool_result"|"image", role, name?, text?, args?, result? }]
 */
export function normalizeMessages(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const items = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role || "user";

    // OpenAI tool results: role "tool" messages
    if (role === "tool") {
      items.push({
        kind: "tool_result",
        role,
        name: msg.name || msg.tool_call_id || "tool",
        result: flattenContent(msg.content),
      });
      continue;
    }

    // OpenAI assistant tool_calls
    if (role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        items.push({
          kind: "tool_call",
          role,
          name: tc?.function?.name || tc?.name || "tool",
          args: tc?.function?.arguments ?? tc?.input ?? "",
        });
      }
    }

    // Content: string or parts/blocks array (OpenAI + Claude)
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part == null) continue;
        if (typeof part === "string") {
          if (part.trim()) items.push({ kind: "text", role, text: part });
          continue;
        }
        switch (part.type) {
          case "text":
            if (part.text) items.push({ kind: "text", role, text: part.text });
            break;
          case "image":
          case "image_url":
            items.push({ kind: "image", role });
            break;
          case "tool_use": // Claude assistant tool call block
            items.push({
              kind: "tool_call",
              role,
              name: part.name || "tool",
              args: part.input ?? "",
            });
            break;
          case "tool_result": // Claude user-side tool result block
            items.push({
              kind: "tool_result",
              role,
              name: part.tool_use_id || "tool",
              result: flattenContent(part.content),
            });
            break;
          case "thinking":
            if (part.thinking) items.push({ kind: "text", role, text: part.thinking, thinking: true });
            break;
          default:
            break;
        }
      }
    } else if (content != null && content !== "") {
      const text = flattenContent(content);
      if (text.trim()) items.push({ kind: "text", role, text });
    }
  }

  return items;
}

/** Normalize the stored `response` summary for display. */
export function normalizeResponse(response) {
  if (!response || typeof response !== "object") return { content: "", thinking: null, error: null, finishReason: null };
  if (response.error) {
    return { content: "", thinking: null, error: { message: String(response.error), status: response.status || null }, finishReason: null };
  }
  return {
    content: flattenContent(response.content),
    thinking: response.thinking || null,
    error: null,
    finishReason: response.finish_reason || null,
  };
}
