const ALLOWED_PROXY_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks4:",
  "socks4a:",
  "socks5:",
  "socks5h:",
]);

/**
 * Parse a proxy import line without changing case-sensitive credentials.
 */
export function parseProxyLine(line, lineNumber) {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (!trimmed) return null;

  let parsedUrl;
  let hostLabel;

  if (trimmed.includes("://")) {
    parsedUrl = new URL(trimmed);
    hostLabel = parsedUrl.port ? `${parsedUrl.hostname}:${parsedUrl.port}` : parsedUrl.hostname;
  } else {
    const parts = trimmed.split(":");
    if (parts.length !== 4) {
      throw new Error("Expected protocol://user:pass@host:port or host:port:user:pass");
    }

    const [host, port, username, password] = parts;
    if (!host || !port || !username || !password) {
      throw new Error("Missing required host, port, username, or password");
    }

    parsedUrl = new URL(
      `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`
    );
    hostLabel = `${host}:${port}`;
  }

  if (!parsedUrl.hostname) {
    throw new Error("Proxy URL must include a hostname");
  }
  if (!ALLOWED_PROXY_PROTOCOLS.has(parsedUrl.protocol)) {
    throw new Error(`Unsupported proxy protocol: ${parsedUrl.protocol}`);
  }

  return {
    proxyUrl: parsedUrl.toString(),
    name: `Imported Proxy ${lineNumber}: ${hostLabel}`,
    noProxy: "",
    isActive: true,
    strictProxy: false,
    type: "http",
    lineNumber,
  };
}

/**
 * Count physical lines without splitting the input into an array. The count
 * stops as soon as it exceeds the supplied limit so callers can reject compact
 * multi-million-line payloads before allocating per-line strings or objects.
 */
export function countPhysicalLinesUpTo(textInput, limit) {
  if (typeof textInput !== "string" || textInput.length === 0) return 0;

  let lineCount = 1;
  for (let index = 0; index < textInput.length; index += 1) {
    if (textInput.charCodeAt(index) !== 10) continue;
    lineCount += 1;
    if (lineCount > limit) return lineCount;
  }

  return lineCount;
}

/**
 * WHATWG URL canonicalization normalizes the scheme, hostname, default port,
 * and root slash while preserving case-sensitive user info and paths.
 */
export function normalizeProxyUrlForComparison(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";

  try {
    return new URL(trimmed).toString();
  } catch {
    // Preserve exact legacy values that pre-date URL validation.
    return trimmed;
  }
}

export function parseProxyBatch(textInput) {
  const lines = textInput.split(/\r?\n/);
  const entries = [];
  const parsingErrors = [];
  let totalLines = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.trim()) continue;
    totalLines += 1;

    try {
      const entry = parseProxyLine(lines[index], index + 1);
      if (entry) entries.push(entry);
    } catch (error) {
      parsingErrors.push({
        lineNumber: index + 1,
        error: error?.message || "Invalid proxy format",
      });
    }
  }

  return { totalLines, entries, parsingErrors };
}

export function deduplicateProxyEntries(entries, existingPools = []) {
  const knownUrls = new Set();

  for (const pool of existingPools) {
    const key = normalizeProxyUrlForComparison(pool?.proxyUrl);
    if (key) knownUrls.add(key);
  }

  const uniqueEntries = [];
  let duplicatesSkipped = 0;

  for (const entry of entries) {
    const key = normalizeProxyUrlForComparison(entry.proxyUrl);
    if (knownUrls.has(key)) {
      duplicatesSkipped += 1;
      continue;
    }

    knownUrls.add(key);
    uniqueEntries.push(entry);
  }

  return { entries: uniqueEntries, duplicatesSkipped };
}
