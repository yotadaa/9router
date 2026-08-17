import { describe, expect, it } from "vitest";

import { initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";

function convertChunks(chunks, request = {}) {
  const state = {
    ...initState(FORMATS.OPENAI_RESPONSES),
    model: "qmodel_38max",
    request: { model: "qd/qmodel_38max", ...request },
  };
  return chunks.flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));
}

function terminalEvent(events) {
  return events.find((event) => ["response.completed", "response.incomplete", "response.failed"].includes(event.event));
}

describe("OpenAI Chat Completions → Responses API streaming contract", () => {
  it("uses unique output indexes and returns the complete terminal Response with final usage", () => {
    const chunks = [
      {
        id: "chatcmpl_stream",
        created: 1_746_000_000,
        model: "qmodel_38max",
        choices: [{ index: 0, delta: { reasoning_content: "considering" } }],
      },
      {
        id: "chatcmpl_stream",
        choices: [{ index: 0, delta: { content: "final answer" } }],
      },
      {
        id: "chatcmpl_stream",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      {
        id: "chatcmpl_stream",
        choices: [],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      },
      null,
    ];

    const events = convertChunks(chunks);
    const outputAdded = events.filter((event) => event.event === "response.output_item.added");
    const outputDone = events.filter((event) => event.event === "response.output_item.done");
    const terminal = terminalEvent(events);

    expect(outputAdded.map((event) => event.data.output_index)).toEqual([0, 1]);
    expect(outputDone.map((event) => event.data.output_index)).toEqual([0, 1]);
    expect(events.map((event) => event.data.sequence_number)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    expect(terminal.event).toBe("response.completed");
    expect(terminal.data.response).toMatchObject({
      id: "resp_chatcmpl_stream",
      object: "response",
      created_at: 1_746_000_000,
      status: "completed",
      background: false,
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "considering" }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "final answer", annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 11,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 18,
      },
    });
  });

  it("keeps multiple choices and tool calls as distinct output items", () => {
    const events = convertChunks([
      {
        id: "chatcmpl_choices",
        choices: [
          { index: 0, delta: { content: "A" } },
          {
            index: 1,
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_weather",
                function: { name: "get_weather", arguments: '{"city":' },
              }],
            },
          },
        ],
      },
      {
        id: "chatcmpl_choices",
        choices: [{
          index: 1,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"Jakarta"}' } }],
          },
        }],
      },
      {
        id: "chatcmpl_choices",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop" },
          { index: 1, delta: {}, finish_reason: "tool_calls" },
        ],
      },
      null,
    ]);

    const terminal = terminalEvent(events);
    const output = terminal.data.response.output;

    expect(terminal.event).toBe("response.completed");
    expect(output.map((item) => item.type)).toEqual(["message", "function_call"]);
    expect(output.map((item) => item.id)).toHaveLength(new Set(output.map((item) => item.id)).size);
    expect(output.find((item) => item.type === "function_call")).toMatchObject({
      call_id: "call_weather",
      name: "get_weather",
      arguments: '{"city":"Jakarta"}',
    });
  });

  it("reports incomplete and failed states instead of a false completed terminal event", () => {
    const incomplete = convertChunks([
      { id: "chatcmpl_length", choices: [{ index: 0, delta: { content: "partial" } }] },
      { id: "chatcmpl_length", choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
      null,
    ]);
    const disconnected = convertChunks([
      { id: "chatcmpl_drop", choices: [{ index: 0, delta: { content: "partial" } }] },
      null,
    ]);

    expect(terminalEvent(incomplete)).toMatchObject({
      event: "response.incomplete",
      data: { response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
    });
    expect(terminalEvent(disconnected)).toMatchObject({
      event: "response.failed",
      data: {
        response: {
          status: "failed",
          error: { code: "stream_disconnected" },
        },
      },
    });
  });
});
