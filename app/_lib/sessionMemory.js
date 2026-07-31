import Redis from "ioredis";

// Phase 7 — session memory. A short, server-side rolling window of each
// visitor's recent conversation, stored in Redis rather than trusted from
// whatever the client resends. This means context survives a page refresh,
// can't be spoofed by a client sending fabricated history, and naturally
// expires after a period of inactivity instead of needing a cleanup job —
// Redis's TTL does that for free, which is the whole reason this is Redis
// and not another Postgres table.
let redis;

function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL);
    redis.on("error", (err) => console.warn("Redis connection error:", err.message));
  }
  return redis;
}

// How many messages (not exchanges — each user/assistant turn is one
// message) the rolling window keeps per session.
const MAX_MESSAGES = Number(process.env.SESSION_HISTORY_MAX_MESSAGES) || 12;
// How long a session's history survives with no new messages. Refreshed on
// every write, so an active conversation never expires mid-use.
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS) || 1800;

function historyKey(sessionId) {
  return `session:${sessionId}:history`;
}

// Returns this session's recent history as [{role, content}, ...], oldest
// first, or [] if there's none yet or Redis is unreachable — a broken
// session store should degrade to "no memory for this turn", never break
// the chat itself.
export async function getSessionHistory(sessionId) {
  try {
    const raw = await getRedis().lrange(historyKey(sessionId), 0, -1);
    return raw.map((entry) => JSON.parse(entry));
  } catch (err) {
    console.warn("Session memory read failed, continuing with no history:", err.message);
    return [];
  }
}

// Appends one turn, trims the list back down to MAX_MESSAGES, and resets
// the TTL. Fire-and-forget from the caller's point of view — a failed write
// here shouldn't fail a request that already has its answer.
export async function appendToSessionHistory(sessionId, role, content) {
  try {
    const key = historyKey(sessionId);
    const client = getRedis();
    await client.rpush(key, JSON.stringify({ role, content }));
    await client.ltrim(key, -MAX_MESSAGES, -1);
    await client.expire(key, SESSION_TTL_SECONDS);
  } catch (err) {
    console.warn("Session memory write failed:", err.message);
  }
}
