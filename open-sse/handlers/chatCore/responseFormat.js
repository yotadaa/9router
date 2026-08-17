import { FORMATS } from "../../translator/formats.js";

/**
 * Keep Responses API output conversion opt-in for chat-completions providers.
 * The input is still translated so /v1/responses remains routable; only the
 * client-facing output stays in Chat Completions format while disabled.
 */
export function getClientResponseFormat(sourceFormat, responsesApiConverterEnabled) {
  if (sourceFormat === FORMATS.OPENAI_RESPONSES && responsesApiConverterEnabled !== true) {
    return FORMATS.OPENAI;
  }
  return sourceFormat;
}
