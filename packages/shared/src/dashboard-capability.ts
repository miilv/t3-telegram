export interface LoopbackDashboardCapability {
  kind: "loopback-dashboard";
  url: string;
}

/** Token-free durable instruction; the current process supplies the URL at delivery time. */
export interface DashboardCapabilityDeliveryIntent {
  kind: "loopback-dashboard-delivery";
}

export function isDashboardCapabilityDeliveryIntent(
  value: unknown,
): value is DashboardCapabilityDeliveryIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === "loopback-dashboard-delivery" && Object.keys(candidate).length === 1;
}

/**
 * The only secret-bearing URL intentionally allowed through a public delivery
 * boundary. Keep this grammar narrower than a generic loopback URL: one
 * random base64url capability in the fragment, with no query or credentials.
 */
export function isLoopbackDashboardCapability(
  value: unknown,
): value is LoopbackDashboardCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "loopback-dashboard" || typeof candidate.url !== "string") return false;
  try {
    const url = new URL(candidate.url);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.username ||
      url.password
    ) return false;
    const fragment = new URLSearchParams(url.hash.slice(1));
    const token = fragment.get("token");
    return fragment.size === 1 && token !== null && /^[A-Za-z0-9_-]{43}$/u.test(token);
  } catch {
    return false;
  }
}
