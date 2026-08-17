import { describe, expect, it } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { getClientResponseFormat } from "../../open-sse/handlers/chatCore/responseFormat.js";

describe("OpenAI Chat Completions → Responses API JSON", () => {
  it("keeps Chat Completions output until the converter is explicitly enabled", () => {
    expect(getClientResponseFormat(FORMATS.OPENAI_RESPONSES, false)).toBe(FORMATS.OPENAI);
    expect(getClientResponseFormat(FORMATS.OPENAI_RESPONSES, true)).toBe(FORMATS.OPENAI_RESPONSES);
    expect(getClientResponseFormat(FORMATS.OPENAI, true)).toBe(FORMATS.OPENAI);
  });

  it("converts text and usage for a non-streaming Responses API request", () => {
    const converted = translateNonStreamingResponse({
      id: "chatcmpl_123",
      object: "chat.completion",
      created: 1_746_000_000,
      model: "qmodel_38max",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "converter works" },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 }
      }
    }, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);

    expect(converted).toMatchObject({
      id: "resp_chatcmpl_123",
      object: "response",
      created_at: 1_746_000_000,
      status: "completed",
      error: null,
      model: "qmodel_38max",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "converter works", annotations: [] }]
      }],
      usage: {
        input_tokens: 11,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 18
      }
    });
    expect(converted).not.toHaveProperty("created");
  });

  it("converts tool calls without emitting an empty message", () => {
    const converted = translateNonStreamingResponse({
      id: "chatcmpl_tools",
      created: 1_746_000_001,
      model: "qmodel_38max",
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_weather",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Jakarta"}' }
          }]
        },
        finish_reason: "tool_calls"
      }]
    }, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);

    expect(converted.output).toEqual([{
      id: "fc_call_weather",
      type: "function_call",
      call_id: "call_weather",
      name: "get_weather",
      arguments: '{"city":"Jakarta"}'
    }]);
  });
});
