import { createHash } from "crypto";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { ROLE, RESPONSES_ITEM } from "../translator/schema/index.js";

// Responses-native providers own previous_response_id themselves. Chat
// Completions providers do not, so retain a privacy-scoped replay transcript
// for the lifetime of this router process.
const responseStore = new Map();
const MAX_STORED_RESPONSES = 5_000;
const MAX_HISTORY_ITEMS = 4_000;

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function scopeForApiKey(apiKey) {
  return createHash("sha256")
    .update(`responses-continuation:${apiKey || "local"}`)
    .digest("hex");
}

function normalizeInput(input) {
  if (typeof input === "string") {
    return [{
      type: RESPONSES_ITEM.MESSAGE,
      role: ROLE.USER,
      content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: input }],
    }];
  }
  return Array.isArray(input) ? clone(input) : [];
}

function findEntry(responseId, apiKey) {
  const entry = responseStore.get(responseId);
  if (!entry) return null;
  if (Date.now() - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
    responseStore.delete(responseId);
    return null;
  }
  if (entry.scope !== scopeForApiKey(apiKey)) return null;
  entry.lastUsed = Date.now();
  return entry;
}

/**
 * Expand a Responses continuation into explicit input history for Chat
 * Completions providers. The returned object preserves the original
 * previous_response_id for the client-facing response envelope, but that id
 * is removed before the Chat Completions request is sent upstream.
 */
export function expandResponsesContinuation(body, apiKey) {
  const previousResponseId = body?.previous_response_id;
  if (!previousResponseId) return { body };

  const parent = findEntry(previousResponseId, apiKey);
  if (!parent) {
    return {
      error: "previous_response_id was not found for this API key. Resend the full conversation in input.",
    };
  }

  const expanded = {
    ...body,
    input: [...clone(parent.history), ...normalizeInput(body.input)],
  };
  if (expanded.instructions === undefined && parent.instructions !== undefined) {
    expanded.instructions = clone(parent.instructions);
  }
  Object.defineProperty(expanded, "_responsesContinuationExpanded", {
    value: true,
    enumerable: false,
  });
  return { body: expanded };
}

/**
 * Save a completed synthetic Responses object so a later request using its
 * previous_response_id can be replayed to a stateless Chat Completions
 * backend. `store:false` is deliberately honored.
 */
export function storeResponsesContinuation(response, request, apiKey) {
  if (!response?.id || !Array.isArray(response.output) || request?.store === false) return;

  const parent = request?.previous_response_id
    ? findEntry(request.previous_response_id, apiKey)
    : null;
  const currentInput = normalizeInput(request?.input);
  const history = request?._responsesContinuationExpanded
    ? currentInput
    : [...(parent ? clone(parent.history) : []), ...currentInput];
  history.push(...clone(response.output));

  if (responseStore.size >= MAX_STORED_RESPONSES && !responseStore.has(response.id)) {
    responseStore.delete(responseStore.keys().next().value);
  }
  responseStore.set(response.id, {
    scope: scopeForApiKey(apiKey),
    instructions: request?.instructions ?? parent?.instructions,
    history: history.slice(-MAX_HISTORY_ITEMS),
    lastUsed: Date.now(),
  });
}

export function _resetResponsesContinuationStore() {
  responseStore.clear();
}

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [responseId, entry] of responseStore) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) responseStore.delete(responseId);
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
cleanup.unref?.();
