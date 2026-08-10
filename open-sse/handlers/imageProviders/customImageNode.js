// Adapter for user-defined custom-image provider nodes.
// Mirrors embeddingProviders/openaiCompatNode.js: baseUrl is read from the
// connection's providerSpecificData snapshot (never a DB read on the hot path).
// The upstream MUST be an OpenAI-compatible /images/generations endpoint.
import { IMAGES_GENERATIONS_PATH } from "./_base.js";

export default {
  buildUrl: (_model, creds) => {
    const raw = creds?.providerSpecificData?.baseUrl || "https://api.openai.com/v1";
    const base = raw.replace(/\/+$/, "").replace(/\/images\/generations$/, "");
    return `${base}${IMAGES_GENERATIONS_PATH}`;
  },
  buildHeaders: (creds) => {
    const headers = { "Content-Type": "application/json" };
    const key = creds?.apiKey || creds?.accessToken;
    if (key) headers["Authorization"] = `Bearer ${key}`;
    return headers;
  },
  buildBody: (model, body) => {
    const out = { model, prompt: body.prompt, n: body.n ?? 1, size: body.size ?? "1024x1024" };
    // Forward known OpenAI image params when present (gateways/official APIs ignore unknowns)
    for (const f of ["quality", "style", "response_format", "background", "output_format", "moderation"]) {
      if (body[f] !== undefined) out[f] = body[f];
    }
    return out;
  },
  normalize: (responseBody) => responseBody, // already OpenAI shape
};
