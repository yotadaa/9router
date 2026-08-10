import { getSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";

let initialized = false;

// Layout modules are evaluated by Next's prerender workers.  Those workers
// must not open or migrate the live SQLite database while `next build` is
// collecting static page data.
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build"
  || process.env.NEXT_PHASE === "phase-export"
  || process.env.NEXT_PHASE === "phase-static";

export async function ensureOutboundProxyInitialized() {
  if (initialized) return true;

  try {
    const settings = await getSettings();
    applyOutboundProxyEnv(settings);
    initialized = true;
  } catch (error) {
    console.error("[ServerInit] Error initializing outbound proxy:", error);
  }

  return initialized;
}

// Defer init so HTTP server accepts connections first. Skip it entirely during
// build/prerender: production server startup will initialize it normally.
if (!isBuildPhase) {
  setImmediate(() => {
    ensureOutboundProxyInitialized().catch(console.log);
  });
}

export default ensureOutboundProxyInitialized;
