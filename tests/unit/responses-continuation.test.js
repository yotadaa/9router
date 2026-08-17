import { beforeEach, describe, expect, it } from "vitest";

import {
  _resetResponsesContinuationStore,
  expandResponsesContinuation,
  storeResponsesContinuation,
} from "../../open-sse/services/responsesContinuation.js";

const request = {
  instructions: "Be concise.",
  input: "Remember the number 4815.",
};
const response = {
  id: "resp_parent",
  object: "response",
  output: [{
    id: "msg_parent",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "I will remember 4815." }],
  }],
};

describe("Responses continuation on Chat Completions backends", () => {
  beforeEach(() => _resetResponsesContinuationStore());

  it("replays the prior input and output, preserving inherited instructions", () => {
    storeResponsesContinuation(response, request, "key-a");

    const result = expandResponsesContinuation({
      model: "qd/qmodel_38max",
      previous_response_id: "resp_parent",
      input: "What number did I ask you to remember?",
    }, "key-a");

    expect(result.error).toBeUndefined();
    expect(result.body.instructions).toBe("Be concise.");
    expect(result.body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Remember the number 4815." }],
      },
      response.output[0],
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "What number did I ask you to remember?" }],
      },
    ]);
  });

  it("does not expose a stored response across API-key scopes and honors store:false", () => {
    storeResponsesContinuation(response, request, "key-a");
    expect(expandResponsesContinuation({ previous_response_id: "resp_parent", input: "again" }, "key-b").error)
      .toMatch(/not found/);

    storeResponsesContinuation({ ...response, id: "resp_ephemeral" }, { ...request, store: false }, "key-a");
    expect(expandResponsesContinuation({ previous_response_id: "resp_ephemeral", input: "again" }, "key-a").error)
      .toMatch(/not found/);
  });
});
