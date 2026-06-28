import type { Context, Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { visits } from "../../db/schema.js";
import { sql } from "drizzle-orm";

const clip = (value: unknown, max = 512): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
};

// Detect device type from user-agent
function detectDevice(ua: string | null): string {
  if (!ua) return "Unknown";
  const u = ua.toLowerCase();
  if (/mobile|android|iphone|ipod|blackberry|windows phone/.test(u)) return "Mobile";
  if (/ipad|tablet/.test(u)) return "Tablet";
  return "Desktop";
}

// Simple browser name from user-agent
function detectBrowser(ua: string | null): string {
  if (!ua) return "Unknown";
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("OPR/") || ua.includes("Opera")) return "Opera";
  if (ua.includes("Chrome/")) return "Chrome";
  if (ua.includes("Firefox/")) return "Firefox";
  if (ua.includes("Safari/") && !ua.includes("Chrome")) return "Safari";
  return "Other";
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Check maintenance mode — block if active
  try {
    const rows = await db
      .select()
      .from(visits)
      .where(sql`visitor_id = '__system__' AND path = '__maintenance__'`)
      .limit(1);
    if (rows[0]?.referrer === "true") {
      // Still allow collect (just don't expose maintenance to client via this route)
    }
  } catch {/* ignore */}

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const visitorId = clip(body.visitorId, 64);
  if (!visitorId) {
    return new Response(JSON.stringify({ error: "Missing visitorId" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rawUA = req.headers.get("user-agent");
  const browser = detectBrowser(rawUA);
  const device = detectDevice(rawUA);

  try {
    await db.insert(visits).values({
      visitorId,
      path: clip(body.path),
      referrer: clip(body.referrer),
      language: clip(body.language, 32),
      // Store device type in timezone field (repurposed, or add new column if schema allows)
      timezone: device,
      screen: clip(body.screen, 32),
      userAgent: `${browser} | ${clip(rawUA, 300) ?? ""}`,
      country: clip(context.geo?.country?.name, 64),
      city: clip(context.geo?.city, 128),
    });
  } catch (e) {
    console.error("collect failed:", e);
    return new Response(JSON.stringify({ error: "Could not store visit" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/collect",
  method: "POST",
};
