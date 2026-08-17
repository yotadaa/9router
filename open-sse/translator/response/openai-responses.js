/**
 * Translator: OpenAI Chat Completions → OpenAI Responses API (response)
 * Converts streaming chunks from Chat Completions to Responses API events
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { buildChunk } from "../concerns/chunk.js";
import { buildUsage } from "../concerns/usage.js";
import { fallbackToolCallId } from "../concerns/toolCall.js";
import { reasoningDelta, extractReasoningText } from "../concerns/reasoning.js";
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM, OPENAI_FINISH, MODEL_FALLBACK } from "../schema/index.js";

/**
 * Translate OpenAI chunk to Responses API events
 * @returns {Array} Array of events with { event, data } structure
 */
export function openaiToOpenAIResponsesResponse(chunk, state) {
  const events = [];
  const emit = createEventEmitter(state, events);

  if (!chunk) {
    flushResponseItems(state, emit);
    sendTerminal(state, emit);
    return events;
  }

  captureResponseMetadata(state, chunk);
  if (!chunk.choices?.length) return events;

  ensureResponseStarted(state, emit);

  for (let position = 0; position < chunk.choices.length; position++) {
    const choice = chunk.choices[position] || {};
    const choiceState = getChoiceState(state, choice.index ?? position);
    const delta = choice.delta || {};

    // Handle reasoning across vendor shapes (reasoning_content / reasoning / reasoning_details).
    const reasoningText = extractReasoningText(delta);
    if (reasoningText) {
      startReasoning(state, emit, choiceState);
      emitReasoningDelta(emit, choiceState, reasoningText);
    }

    if (typeof delta.content === "string" && delta.content) {
      // Providers that expose a dedicated reasoning delta switch to normal
      // content once reasoning is complete. Close that earlier output item
      // before opening the message item so lifecycle events stay ordered.
      if (choiceState.reasoning && !choiceState.inThinking) {
        closeReasoning(state, emit, choiceState);
      }
      emitDeltaContent(state, emit, choiceState, delta.content);
    }

    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      closeMessage(state, emit, choiceState);
      closeReasoning(state, emit, choiceState);
      for (let toolPosition = 0; toolPosition < delta.tool_calls.length; toolPosition++) {
        emitToolCall(state, emit, choiceState, delta.tool_calls[toolPosition], toolPosition);
      }
    }

    // A Chat Completions finish_reason is the only reliable success signal.
    // Keep response.completed until stream flush so an optional usage-only final
    // chunk is included in the terminal Responses object.
    if (choice.finish_reason) {
      choiceState.finishReason = choice.finish_reason;
      state.sawFinishReason = true;
      state.finishedChoices ??= {};
      state.finishedChoices[String(choiceState.choiceIndex)] = true;
      closeChoiceItems(state, emit, choiceState);
    }
  }

  return events;
}

function createEventEmitter(state, events) {
  return (eventType, data) => {
    state.seq = (state.seq || 0) + 1;
    data.sequence_number = state.seq;
    events.push({ event: eventType, data });
  };
}

function captureResponseMetadata(state, chunk) {
  if (Number.isFinite(chunk.created)) state.created = chunk.created;
  if (typeof chunk.model === "string" && chunk.model) state.model = chunk.model;
  if (chunk.id) state.responseId = toResponseId(chunk.id);
  if (chunk.usage && typeof chunk.usage === "object") {
    state.responseUsage = toResponsesUsage(chunk.usage);
  }
}

function toResponseId(id) {
  return String(id).startsWith("resp_") ? String(id) : `resp_${id}`;
}

function ensureResponseStarted(state, emit) {
  if (state.started) return;
  state.started = true;
  emit("response.created", {
    type: "response.created",
    response: buildResponseObject(state, "in_progress"),
  });
  emit("response.in_progress", {
    type: "response.in_progress",
    response: buildResponseObject(state, "in_progress"),
  });
}

function getChoiceState(state, choiceIndex) {
  state.responseChoices ??= {};
  const key = String(choiceIndex);
  if (!state.responseChoices[key]) {
    state.responseChoices[key] = {
      choiceIndex,
      inThinking: false,
      reasoning: null,
      message: null,
      tools: {},
      finishReason: null,
    };
  }
  return state.responseChoices[key];
}

function nextOutputIndex(state) {
  const index = state.nextOutputIndex || 0;
  state.nextOutputIndex = index + 1;
  return index;
}

function emitDeltaContent(state, emit, choiceState, rawContent) {
  let content = rawContent;

  if (content.includes("<think>")) {
    choiceState.inThinking = true;
    content = content.replace("<think>", "");
    startReasoning(state, emit, choiceState);
  }

  if (content.includes("</think>")) {
    const parts = content.split("</think>");
    const thinking = parts.shift();
    if (thinking) {
      startReasoning(state, emit, choiceState);
      emitReasoningDelta(emit, choiceState, thinking);
    }
    closeReasoning(state, emit, choiceState);
    choiceState.inThinking = false;
    content = parts.join("</think>");
  }

  if (choiceState.inThinking) {
    if (content) {
      startReasoning(state, emit, choiceState);
      emitReasoningDelta(emit, choiceState, content);
    }
    return;
  }

  if (content) emitTextContent(state, emit, choiceState, content);
}

/**
 * Convert one non-streaming OpenAI Chat Completions response into an OpenAI
 * Responses API response. Streaming requests use openaiToOpenAIResponsesResponse
 * above; this covers providers such as Qoder that return JSON for stream:false.
 *
 * @param {object} completion OpenAI Chat Completions response body
 * @returns {object} OpenAI Responses API response body
 */
export function openAICompletionToOpenAIResponsesResponse(completion = {}, request = {}) {
  const createdAt = Number.isFinite(completion.created)
    ? completion.created
    : Math.floor(Date.now() / 1000);
  const responseId = completion.id ? toResponseId(completion.id) : `resp_${Date.now()}`;
  const output = [];

  for (const choice of completion.choices || []) {
    appendCompletionChoiceOutput(output, responseId, choice || {});
  }

  const incompleteDetails = getCompletionIncompleteDetails(completion.choices || []);
  return buildResponseObject({
    responseId,
    created: createdAt,
    model: completion.model || MODEL_FALLBACK,
    outputItems: Object.fromEntries(output.map((item, index) => [index, item])),
    responseUsage: completion.usage ? toResponsesUsage(completion.usage) : null,
    request,
  }, incompleteDetails ? "incomplete" : "completed", { incompleteDetails });
}

function appendCompletionChoiceOutput(output, responseId, choice) {
  const message = choice.message || {};
  const reasoningText = extractReasoningText(message);
  if (reasoningText) {
    output.push({
      id: `rs_${responseId}_${output.length}`,
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoningText }],
    });
  }

  const text = extractMessageText(message.content);
  if (text || (!message.tool_calls?.length && !message.function_call)) {
    output.push({
      id: `msg_${responseId}_${output.length}`,
      type: RESPONSES_ITEM.MESSAGE,
      role: ROLE.ASSISTANT,
      content: [{
        type: RESPONSES_ITEM.OUTPUT_TEXT,
        text,
        annotations: Array.isArray(message.annotations) ? message.annotations : [],
      }],
    });
  }

  const toolCalls = message.tool_calls || (message.function_call ? [{ function: message.function_call }] : []);
  for (let index = 0; index < toolCalls.length; index++) {
    const toolCall = toolCalls[index] || {};
    const callId = toolCall.id || `call_${responseId}_${output.length}`;
    output.push({
      id: `fc_${callId}`,
      type: RESPONSES_ITEM.FUNCTION_CALL,
      call_id: callId,
      name: toolCall.function?.name || toolCall.name || "",
      arguments: stringifyToolArguments(toolCall.function?.arguments ?? toolCall.arguments),
    });
  }
}

function getCompletionIncompleteDetails(choices) {
  const reasons = choices.map((choice) => choice?.finish_reason);
  if (reasons.includes(OPENAI_FINISH.LENGTH)) return { reason: "max_output_tokens" };
  if (reasons.includes(OPENAI_FINISH.CONTENT_FILTER)) return { reason: "content_filter" };
  return null;
}

function extractMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === OPENAI_BLOCK.TEXT || part?.type === RESPONSES_ITEM.OUTPUT_TEXT) return part.text || "";
      return "";
    })
    .join("");
}

function stringifyToolArguments(argumentsValue) {
  if (typeof argumentsValue === "string") return argumentsValue;
  if (argumentsValue === undefined || argumentsValue === null) return "{}";
  try {
    return JSON.stringify(argumentsValue);
  } catch {
    return "{}";
  }
}

// Helper functions
function startReasoning(state, emit, choiceState) {
  if (choiceState.reasoning && !choiceState.reasoning.done) return choiceState.reasoning;
  const outputIndex = nextOutputIndex(state);
  const reasoning = {
    id: `rs_${state.responseId}_${outputIndex}`,
    outputIndex,
    text: "",
    done: false,
  };
  choiceState.reasoning = reasoning;

  emit("response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: { id: reasoning.id, type: RESPONSES_ITEM.REASONING, summary: [] },
  });
  emit("response.reasoning_summary_part.added", {
    type: "response.reasoning_summary_part.added",
    item_id: reasoning.id,
    output_index: outputIndex,
    summary_index: 0,
    part: { type: RESPONSES_ITEM.SUMMARY_TEXT, text: "" },
  });
  return reasoning;
}

function emitReasoningDelta(emit, choiceState, text) {
  const reasoning = choiceState.reasoning;
  if (!reasoning || !text || reasoning.done) return;
  reasoning.text += text;
  emit("response.reasoning_summary_text.delta", {
    type: "response.reasoning_summary_text.delta",
    item_id: reasoning.id,
    output_index: reasoning.outputIndex,
    summary_index: 0,
    delta: text,
  });
}

function closeReasoning(state, emit, choiceState) {
  const reasoning = choiceState.reasoning;
  if (!reasoning || reasoning.done) return;
  reasoning.done = true;
  const item = {
    id: reasoning.id,
    type: RESPONSES_ITEM.REASONING,
    summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning.text }],
  };

  emit("response.reasoning_summary_text.done", {
    type: "response.reasoning_summary_text.done",
    item_id: reasoning.id,
    output_index: reasoning.outputIndex,
    summary_index: 0,
    text: reasoning.text,
  });
  emit("response.reasoning_summary_part.done", {
    type: "response.reasoning_summary_part.done",
    item_id: reasoning.id,
    output_index: reasoning.outputIndex,
    summary_index: 0,
    part: { type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning.text },
  });
  emitOutputItemDone(state, emit, reasoning.outputIndex, item);
}

function emitTextContent(state, emit, choiceState, content) {
  if (!choiceState.message) {
    const outputIndex = nextOutputIndex(state);
    choiceState.message = {
      id: `msg_${state.responseId}_${outputIndex}`,
      outputIndex,
      text: "",
      contentAdded: false,
      done: false,
    };
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { id: choiceState.message.id, type: RESPONSES_ITEM.MESSAGE, content: [], role: ROLE.ASSISTANT },
    });
  }

  const message = choiceState.message;
  if (!message.contentAdded) {
    message.contentAdded = true;
    emit("response.content_part.added", {
      type: "response.content_part.added",
      item_id: message.id,
      output_index: message.outputIndex,
      content_index: 0,
      part: { type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: "" },
    });
  }

  message.text += content;
  emit("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: message.id,
    output_index: message.outputIndex,
    content_index: 0,
    delta: content,
    logprobs: [],
  });
}

function closeMessage(state, emit, choiceState) {
  const message = choiceState.message;
  if (!message || message.done) return;
  message.done = true;
  const part = { type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: message.text };
  const item = { id: message.id, type: RESPONSES_ITEM.MESSAGE, content: [part], role: ROLE.ASSISTANT };

  emit("response.output_text.done", {
    type: "response.output_text.done",
    item_id: message.id,
    output_index: message.outputIndex,
    content_index: 0,
    text: message.text,
    logprobs: [],
  });
  emit("response.content_part.done", {
    type: "response.content_part.done",
    item_id: message.id,
    output_index: message.outputIndex,
    content_index: 0,
    part,
  });
  emitOutputItemDone(state, emit, message.outputIndex, item);
}

function emitToolCall(state, emit, choiceState, toolCall = {}, fallbackIndex) {
  const toolIndex = toolCall.index ?? fallbackIndex;
  const key = String(toolIndex);
  let tool = choiceState.tools[key];
  if (!tool) {
    const callId = toolCall.id || fallbackToolCallId();
    tool = {
      id: `fc_${callId}`,
      callId,
      outputIndex: nextOutputIndex(state),
      name: "",
      arguments: "",
      started: false,
      done: false,
    };
    choiceState.tools[key] = tool;
  }

  if (typeof toolCall.function?.name === "string" && toolCall.function.name) {
    tool.name = toolCall.function.name;
  }
  if (!tool.started) {
    tool.started = true;
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: tool.outputIndex,
      item: {
        id: tool.id,
        type: RESPONSES_ITEM.FUNCTION_CALL,
        arguments: "",
        call_id: tool.callId,
        name: tool.name,
      },
    });
  }

  if (typeof toolCall.function?.arguments === "string" && toolCall.function.arguments) {
    tool.arguments += toolCall.function.arguments;
    emit("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: tool.id,
      output_index: tool.outputIndex,
      delta: toolCall.function.arguments,
    });
  }
}

function closeToolCall(state, emit, tool) {
  if (!tool || tool.done) return;
  tool.done = true;
  const argumentsValue = tool.arguments || "{}";
  const item = {
    id: tool.id,
    type: RESPONSES_ITEM.FUNCTION_CALL,
    arguments: argumentsValue,
    call_id: tool.callId,
    name: tool.name,
  };
  emit("response.function_call_arguments.done", {
    type: "response.function_call_arguments.done",
    item_id: tool.id,
    output_index: tool.outputIndex,
    arguments: argumentsValue,
  });
  emitOutputItemDone(state, emit, tool.outputIndex, item);
}

function emitOutputItemDone(state, emit, outputIndex, item) {
  state.outputItems ??= {};
  state.outputItems[outputIndex] = item;
  emit("response.output_item.done", {
    type: "response.output_item.done",
    output_index: outputIndex,
    item,
  });
}

function closeChoiceItems(state, emit, choiceState) {
  closeMessage(state, emit, choiceState);
  closeReasoning(state, emit, choiceState);
  for (const tool of Object.values(choiceState.tools)) closeToolCall(state, emit, tool);
}

function flushResponseItems(state, emit) {
  for (const choiceState of Object.values(state.responseChoices || {})) {
    closeChoiceItems(state, emit, choiceState);
  }
}

function sendTerminal(state, emit) {
  if (state.completedSent) return;
  ensureResponseStarted(state, emit);
  state.completedSent = true;

  if (!hasFinishedAllChoices(state)) {
    const response = buildResponseObject(state, "failed", {
      error: {
        type: "server_error",
        code: "stream_disconnected",
        message: "Chat Completions stream closed before a finish reason.",
      },
    });
    emit("response.failed", { type: "response.failed", response });
    return;
  }

  const incompleteDetails = getIncompleteDetails(state);
  const status = incompleteDetails ? "incomplete" : "completed";
  emit(status === "completed" ? "response.completed" : "response.incomplete", {
    type: status === "completed" ? "response.completed" : "response.incomplete",
    response: buildResponseObject(state, status, { incompleteDetails }),
  });
}

/**
 * A multi-choice Chat Completions stream can finish each choice in a separate
 * chunk. Do not report a successful Response while one of its observed
 * choices is still open.
 */
function hasFinishedAllChoices(state) {
  const choiceKeys = Object.keys(state.responseChoices || {});
  return state.sawFinishReason
    && choiceKeys.length > 0
    && choiceKeys.every((choiceKey) => state.finishedChoices?.[choiceKey]);
}

function getIncompleteDetails(state) {
  const reasons = Object.values(state.responseChoices || {}).map((choice) => choice.finishReason);
  if (reasons.includes(OPENAI_FINISH.LENGTH)) return { reason: "max_output_tokens" };
  if (reasons.includes(OPENAI_FINISH.CONTENT_FILTER)) return { reason: "content_filter" };
  return null;
}

function buildResponseObject(state, status, { error = null, incompleteDetails = null } = {}) {
  const request = state.request || {};
  const output = Object.entries(state.outputItems || {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, item]) => item);
  const terminal = status !== "in_progress";

  return {
    id: state.responseId,
    object: "response",
    created_at: state.created,
    status,
    // Chat Completions providers are synchronous. They cannot emulate
    // Responses background jobs, so expose the truthful Responses default.
    background: false,
    error,
    incomplete_details: incompleteDetails,
    model: state.model || MODEL_FALLBACK,
    output,
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    previous_response_id: request.previous_response_id ?? null,
    store: request.store ?? true,
    temperature: request.temperature ?? 1,
    top_p: request.top_p ?? 1,
    truncation: request.truncation ?? "disabled",
    usage: terminal ? (state.responseUsage || null) : null,
    ...(terminal ? { completed_at: Math.floor(Date.now() / 1000) } : {}),
  };
}

function toResponsesUsage(usage) {
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: usage.total_tokens ?? inputTokens + outputTokens,
  };
}

// currentToolCallId is intentionally sticky for the current turn so flush/completion
  // can still finalize as tool_calls even if the tool call was emitted before stream end.
function computeFinishReason(state) {
   return state.toolCallIndex > 0 || state.currentToolCallId
    ? OPENAI_FINISH.TOOL_CALLS
    : OPENAI_FINISH.STOP;
}

/**
 * Translate OpenAI Responses API chunk to OpenAI Chat Completions format
 * This is for when Codex returns data and we need to send it to an OpenAI-compatible client
 */
export function openaiResponsesToOpenAIResponse(chunk, state) {
  if (!chunk) {
    // Flush: send final chunk with finish_reason
    if (state.finishReasonSent || !state.started) return null;

    const finishReason = computeFinishReason(state);

    state.finishReasonSent = true;
    state.finishReason = finishReason;

    const finalChunk = buildChunk(
      { id: state.chatId || `chatcmpl-${Date.now()}`, created: state.created || Math.floor(Date.now() / 1000), model: state.model || MODEL_FALLBACK },
      {},
      finishReason
    );

    if (state.usage && typeof state.usage === "object") {
      finalChunk.usage = state.usage;
    }

    return finalChunk;
  }

  // Handle different event types from Responses API
  const eventType = chunk.type || chunk.event;
  const data = chunk.data || chunk;

  // Initialize state
  if (!state.started) {
    state.started = true;
    state.chatId = `chatcmpl-${Date.now()}`;
    state.created = Math.floor(Date.now() / 1000);
    state.toolCallIndex = 0;
    state.currentToolCallId = null;
  }

  // Text content delta
  if (eventType === "response.output_text.delta") {
    const delta = data.delta || "";
    if (!delta) return null;

    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { content: delta }
    );
  }

  // Text content done (ignore, we handle via delta)
  if (eventType === "response.output_text.done") {
    return null;
  }

  // Function call started (standard function_call or custom_tool_call)
  if (eventType === "response.output_item.added" && (data.item?.type === RESPONSES_ITEM.FUNCTION_CALL || data.item?.type === "custom_tool_call")) {
    const item = data.item;
    state.currentToolCallId = item.call_id || fallbackToolCallId();

    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      {
        tool_calls: [{
          index: state.toolCallIndex,
          id: state.currentToolCallId,
          type: OPENAI_BLOCK.FUNCTION,
          function: { name: item.name || "", arguments: "" }
        }]
      }
    );
  }

  // Function call arguments delta (standard or custom_tool_call variant)
  if (eventType === "response.function_call_arguments.delta" || eventType === "response.custom_tool_call_input.delta") {
    const argsDelta = data.delta || "";
    if (!argsDelta) return null;

    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { tool_calls: [{ index: state.toolCallIndex, function: { arguments: argsDelta } }] }
    );
  }

  // Function call done (standard or custom_tool_call variant)
  if (eventType === "response.output_item.done" && (data.item?.type === RESPONSES_ITEM.FUNCTION_CALL || data.item?.type === "custom_tool_call")) {
    state.toolCallIndex++;
    return null;
  }

  // Response completed
  if (eventType === "response.completed" || eventType === "response.done") {
    // Extract usage from response.completed event
    const responseUsage = data.response?.usage;
    if (responseUsage && typeof responseUsage === "object") {
      const inputTokens = responseUsage.input_tokens || responseUsage.prompt_tokens || 0;
      const outputTokens = responseUsage.output_tokens || responseUsage.completion_tokens || 0;
      // OpenAI Responses API: input_tokens already includes cached_tokens
      // Cache info is in input_tokens_details.cached_tokens
      const cacheReadTokens = responseUsage.input_tokens_details?.cached_tokens || responseUsage.cache_read_input_tokens || 0;
      
      state.usage = buildUsage({ promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens, cachedTokens: cacheReadTokens });
    }
    
    if (!state.finishReasonSent) {
      const finishReason = computeFinishReason(state);

      state.finishReasonSent = true;
      state.finishReason = finishReason; // Mark for usage injection in stream.js
      
      const finalChunk = buildChunk(
        { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
        {},
        finishReason
      );

      // Include usage in final chunk if available
      if (state.usage && typeof state.usage === "object") {
        finalChunk.usage = state.usage;
      }
      
      return finalChunk;
    }
    return null;
  }

  // Error events from Responses API (e.g. model_not_found)
  if (eventType === "error" || eventType === "response.failed") {
    // Avoid emitting duplicate errors (error + response.failed arrive back-to-back)
    if (state.finishReasonSent) return null;

    const error = data.error || data.response?.error;
    if (error) {
      state.error = error;
      state.finishReasonSent = true;

      // Surface the error as an OpenAI-compatible error chunk
      return buildChunk(
        { id: state.chatId || `chatcmpl-${Date.now()}`, created: state.created || Math.floor(Date.now() / 1000), model: state.model || MODEL_FALLBACK },
        { content: `[Error] ${error.message || JSON.stringify(error)}` },
        OPENAI_FINISH.STOP
      );
    }
    return null;
  }

  // Reasoning summary delta → emit as reasoning_content for client thinking display
  if (eventType === "response.reasoning_summary_text.delta") {
    const delta = data.delta || "";
    if (!delta) return null;
    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      reasoningDelta(delta)
    );
  }

  // Ignore other events
  return null;
}

// Register both directions
register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, null, openaiToOpenAIResponsesResponse);
register(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, null, openaiResponsesToOpenAIResponse);
