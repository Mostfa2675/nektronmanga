import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { visits } from "../../db/schema.js";
import { desc, count, sql } from "drizzle-orm";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "sUp1LgkDE9H";

// ── Brute-force protection (in-memory, per isolate) ──────────────────────────
const FAIL_WINDOW_MS = 10 * 60 * 1000; // 10 min
const MAX_FAILS = 8;
const LOCKOUT_MS = 30 * 60 * 1000; // 30 min lockout after max fails

const failLog: Map<string, { count: number; first: number; lockedUntil?: number }> = new Map();

function clientIp(req: Request): string {
  return (
    req.headers.get("x-nf-client-connection-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function checkRateLimit(ip: string): { blocked: boolean; reason?: string } {
  const now = Date.now();
  const rec = failLog.get(ip);
  if (!rec) return { blocked: false };

  // Still locked out
  if (rec.lockedUntil && now < rec.lockedUntil) {
    const mins = Math.ceil((rec.lockedUntil - now) / 60000);
    return { blocked: true, reason: `locked_${mins}` };
  }

  // Reset window if it expired
  if (now - rec.first > FAIL_WINDOW_MS) {
    failLog.delete(ip);
    return { blocked: false };
  }

  return { blocked: false };
}

function recordFail(ip: string) {
  const now = Date.now();
  const rec = failLog.get(ip) ?? { count: 0, first: now };
  rec.count++;
  if (rec.count >= MAX_FAILS) rec.lockedUntil = now + LOCKOUT_MS;
  failLog.set(ip, rec);
}

function clearFails(ip: string) {
  failLog.delete(ip);
}

// ── CORS / security headers ──────────────────────────────────────────────────
function secureHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extra,
  };
}

// ── Helper: reject with delay (mitigates timing attacks) ────────────────────
async function rejectUnauth(reason = "Unauthorized"): Promise<Response> {
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
  return new Response(JSON.stringify({ error: reason }), {
    status: 401,
    headers: secureHeaders(),
  });
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async (req: Request) => {
  const ip = clientIp(req);
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

  // Block non-GET/POST immediately
  if (method !== "GET" && method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: secureHeaders(),
    });
  }

  // Rate-limit check (before reading password)
  const limitCheck = checkRateLimit(ip);
  if (limitCheck.blocked) {
    return new Response(
      JSON.stringify({ error: "Too many failed attempts. Try again later." }),
      { status: 429, headers: secureHeaders({ "Retry-After": "1800" }) }
    );
  }

  // Auth: accept from query param (GET) or JSON body (POST)
  let pass: string | null = null;
  let action: string | null = null;
  let payload: Record<string, unknown> = {};

  if (method === "POST") {
    try {
      payload = await req.json();
      pass = (payload.pass as string) ?? null;
      action = (payload.action as string) ?? null;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: secureHeaders(),
      });
    }
  } else {
    pass = url.searchParams.get("pass") || req.headers.get("x-admin-pass");
  }

  if (pass !== ADMIN_PASSWORD) {
    recordFail(ip);
    return rejectUnauth();
  }

  // Good login → clear fail counter
  clearFails(ip);

  // ── Action: set maintenance mode ─────────────────────────────────────────
  if (action === "set_maintenance") {
    const enable = !!(payload.enabled);
    // Store in env is not possible at runtime, so we use the DB visits table
    // as a side-channel key-value store via a sentinel row.
    // We store: visitorId = "__system__", path = "__maintenance__", referrer = "true"/"false"
    try {
      // Delete existing sentinel
      await db
        .delete(visits)
        .where(sql`visitor_id = '__system__' AND path = '__maintenance__'`);
      // Insert new
      await db.insert(visits).values({
        visitorId: "__system__",
        path: "__maintenance__",
        referrer: enable ? "true" : "false",
        language: null,
        timezone: null,
        screen: null,
        userAgent: null,
        country: null,
        city: null,
      });
      return new Response(
        JSON.stringify({ ok: true, maintenance: enable }),
        { status: 200, headers: secureHeaders() }
      );
    } catch (e) {
      console.error("maintenance toggle failed:", e);
      return new Response(JSON.stringify({ error: "DB error" }), {
        status: 500,
        headers: secureHeaders(),
      });
    }
  }

  // ── Default: return dashboard data ───────────────────────────────────────
  try {
    // Check if DB is available first
    let dbAvailable = true;
    try {
      await db.select({ total: count() }).from(visits).limit(1);
    } catch (dbError) {
      console.error("DB connection check failed:", dbError);
      dbAvailable = false;
    }

    if (!dbAvailable) {
      // Return empty data if DB is not available
      const data = {
        summary: {
          totalVisits: 0,
          uniqueVisitors: 0,
          maintenanceMode: false,
        },
        topPages: [],
        topCountries: [],
        topCities: [],
        topScreens: [],
        topBrowsers: [],
        topDevices: [],
        recent: [],
      };
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: secureHeaders(),
      });
    }

    const [
      totalRows,
      recentVisits,
      topPages,
      topCountries,
      topCities,
      topScreens,
      topBrowsers,
      topDevices,
      maintenanceRow,
    ] = await Promise.all([
      db
        .select({ total: count() })
        .from(visits)
        .where(sql`visitor_id != '__system__'`),

      db
        .select()
        .from(visits)
        .where(sql`visitor_id != '__system__'`)
        .orderBy(desc(visits.createdAt))
        .limit(100),

      db
        .select({ path: visits.path, visits: count() })
        .from(visits)
        .where(sql`visitor_id != '__system__'`)
        .groupBy(visits.path)
        .orderBy(desc(count()))
        .limit(10),

      db
        .select({ country: visits.country, visits: count() })
        .from(visits)
        .where(sql`visitor_id != '__system__'`)
        .groupBy(visits.country)
        .orderBy(desc(count()))
        .limit(10),

      db
        .select({ city: visits.city, visits: count() })
        .from(visits)
        .where(sql`visitor_id != '__system__'`)
        .groupBy(visits.city)
        .orderBy(desc(count()))
        .limit(10),

      db
        .select({ screen: visits.screen, visits: count() })
        .from(visits)
        .where(sql`visitor_id != '__system__'`)
        .groupBy(visits.screen)
        .orderBy(desc(count()))
        .limit(8),

      // Browser from user_agent (extract first token before /)
      db
        .select({
          browser: sql<string>`split_part(user_agent, '/', 1)`,
          visits: count(),
        })
        .from(visits)
        .where(sql`visitor_id != '__system__' AND user_agent IS NOT NULL`)
        .groupBy(sql`split_part(user_agent, '/', 1)`)
        .orderBy(desc(count()))
        .limit(8),

      // Device type stored in userAgent field after a separator we'll use in collect
      db
        .select({ device: visits.timezone, visits: count() })
        .from(visits)
        .where(sql`visitor_id != '__system__'`)
        .groupBy(visits.timezone)
        .orderBy(desc(count()))
        .limit(6),

      db
        .select()
        .from(visits)
        .where(sql`visitor_id = '__system__' AND path = '__maintenance__'`)
        .limit(1),
    ]);

    const maintenanceEnabled =
      maintenanceRow[0]?.referrer === "true";

    const data = {
      summary: {
        totalVisits: totalRows[0]?.total ?? 0,
        uniqueVisitors: new Set(recentVisits.map((v) => v.visitorId)).size,
        maintenanceMode: maintenanceEnabled,
      },
      topPages,
      topCountries,
      topCities,
      topScreens,
      topBrowsers,
      topDevices,
      recent: recentVisits,
    };

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: secureHeaders(),
    });
  } catch (e) {
    console.error("admin data fetch failed:", e);
    // Return empty data on error instead of 500 to avoid 502
    const data = {
      summary: {
        totalVisits: 0,
        uniqueVisitors: 0,
        maintenanceMode: false,
      },
      topPages: [],
      topCountries: [],
      topCities: [],
      topScreens: [],
      topBrowsers: [],
      topDevices: [],
      recent: [],
    };
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: secureHeaders(),
    });
  }
};

export const config: Config = {
  path: "/api/admin",
};
