import { NextResponse } from "next/server";
import { createProviderNode, getProviderNodes } from "@/models";
import { OPENAI_COMPATIBLE_PREFIX, ANTHROPIC_COMPATIBLE_PREFIX, CUSTOM_EMBEDDING_PREFIX, CUSTOM_IMAGE_PREFIX, CUSTOM_VIDEO_PREFIX } from "@/shared/constants/providers";
import { generateId } from "@/shared/utils";

export const dynamic = "force-dynamic";

const OPENAI_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

const ANTHROPIC_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.anthropic.com/v1",
};

const CUSTOM_EMBEDDING_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

const CUSTOM_IMAGE_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

const CUSTOM_VIDEO_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1/videos",
};

// Prefixes are the routing key in model strings (prefix/model) — duplicates would
// silently misroute. Guard across ALL node types at create time.
async function assertUniquePrefix(prefix) {
  const nodes = await getProviderNodes();
  return !nodes.some((n) => n.prefix === prefix);
}

// GET /api/provider-nodes - List all provider nodes
export async function GET() {
  try {
    const nodes = await getProviderNodes();
    return NextResponse.json({ nodes });
  } catch (error) {
    console.log("Error fetching provider nodes:", error);
    return NextResponse.json({ error: "Failed to fetch provider nodes" }, { status: 500 });
  }
}

// POST /api/provider-nodes - Create provider node
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, prefix, apiType, baseUrl, type } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (!prefix?.trim()) {
      return NextResponse.json({ error: "Prefix is required" }, { status: 400 });
    }

    // Determine type
    const nodeType = type || "openai-compatible";

    if (nodeType === "openai-compatible") {
      if (!apiType || !["chat", "responses"].includes(apiType)) {
        return NextResponse.json({ error: "Invalid OpenAI compatible API type" }, { status: 400 });
      }

      const node = await createProviderNode({
        id: `${OPENAI_COMPATIBLE_PREFIX}${apiType}-${generateId()}`,
        type: "openai-compatible",
        prefix: prefix.trim(),
        apiType,
        baseUrl: (baseUrl || OPENAI_COMPATIBLE_DEFAULTS.baseUrl).trim(),
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "custom-embedding") {
      // Strip trailing slash and /embeddings if user pasted full endpoint
      let sanitizedBaseUrl = (baseUrl || CUSTOM_EMBEDDING_DEFAULTS.baseUrl).trim().replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/embeddings")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -"/embeddings".length);
      }

      const node = await createProviderNode({
        id: `${CUSTOM_EMBEDDING_PREFIX}${generateId()}`,
        type: "custom-embedding",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "custom-image") {
      if (!(await assertUniquePrefix(prefix.trim()))) {
        return NextResponse.json({ error: `Prefix "${prefix.trim()}" is already used by another provider node` }, { status: 409 });
      }
      // Strip trailing slash and /images/generations if user pasted full endpoint
      let sanitizedBaseUrl = (baseUrl || CUSTOM_IMAGE_DEFAULTS.baseUrl).trim().replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/images/generations")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -"/images/generations".length);
      }

      const node = await createProviderNode({
        id: `${CUSTOM_IMAGE_PREFIX}${generateId()}`,
        type: "custom-image",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "custom-video") {
      if (!(await assertUniquePrefix(prefix.trim()))) {
        return NextResponse.json({ error: `Prefix "${prefix.trim()}" is already used by another provider node` }, { status: 409 });
      }
      const { videoApi } = body;
      if (videoApi && !["xai", "sora"].includes(videoApi)) {
        return NextResponse.json({ error: "Invalid video API shape (expected xai or sora)" }, { status: 400 });
      }
      // Strip trailing slash and /videos if user pasted the jobs endpoint
      let sanitizedBaseUrl = (baseUrl || CUSTOM_VIDEO_DEFAULTS.baseUrl).trim().replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/videos")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -"/videos".length);
      }

      const node = await createProviderNode({
        id: `${CUSTOM_VIDEO_PREFIX}${generateId()}`,
        type: "custom-video",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        videoApi: videoApi || "xai",
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "anthropic-compatible") {
      // Sanitize Base URL: remove trailing slash, and remove trailing /messages if user added it
      // This prevents double-appending /messages at runtime
      let sanitizedBaseUrl = (baseUrl || ANTHROPIC_COMPATIBLE_DEFAULTS.baseUrl).trim().replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/messages")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -9); // remove /messages
      }

      const node = await createProviderNode({
        id: `${ANTHROPIC_COMPATIBLE_PREFIX}${generateId()}`,
        type: "anthropic-compatible",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    return NextResponse.json({ error: "Invalid provider node type" }, { status: 400 });
  } catch (error) {
    console.log("Error creating provider node:", error);
    return NextResponse.json({ error: "Failed to create provider node" }, { status: 500 });
  }
}
