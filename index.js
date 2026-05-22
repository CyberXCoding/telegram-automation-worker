const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Logger } = require("telegram/extensions/Logger");

// ──────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────

const API_IDS = (process.env.API_IDS || "").split("|").filter(Boolean).map(Number);
const API_HASHES = (process.env.API_HASHES || "").split("|").filter(Boolean);
const STRING_SESSIONS = (process.env.STRING_SESSIONS || "").split("|").filter(Boolean);
const TARGET_BOTS = (process.env.TARGET_BOTS || "").split("|").filter(Boolean);
const SINGLE_RUN = (process.env.SINGLE_RUN || "").toLowerCase() === "true";
const LOOP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const FLOOD_WAIT_MULTIPLIER = 1000;

// ──────────────────────────────────────────────
// Anti-Ban Safety Configuration
// ──────────────────────────────────────────────
// These values are designed to mimic human behavior
// and avoid triggering Telegram's spam detection.

const SAFETY = {
  // Delay between the two /start messages to the same bot
  START_CMD_MIN_MS: 4000,     // 4 seconds minimum
  START_CMD_MAX_MS: 8000,     // 8 seconds maximum

  // Delay between switching to a different bot
  BETWEEN_BOT_MIN_MS: 6000,   // 6 seconds minimum
  BETWEEN_BOT_MAX_MS: 12000,  // 12 seconds maximum

  // Stagger delay before each session starts (so all 3 don't start together)
  SESSION_STAGGER_MIN_MS: 5000,   // 5 seconds
  SESSION_STAGGER_MAX_MS: 20000,  // 20 seconds

  // Max consecutive messages before taking a break
  MAX_MESSAGES_BEFORE_BREAK: 4,
  // Break duration after MAX_MESSAGES_BEFORE_BREAK
  BREAK_MIN_MS: 15000,   // 15 seconds
  BREAK_MAX_MS: 30000,   // 30 seconds

  // Add random jitter to loop interval (±5 min)
  LOOP_JITTER_MIN_MS: -300000,  // -5 minutes
  LOOP_JITTER_MAX_MS: 300000,   // +5 minutes
};

// ──────────────────────────────────────────────
// Utility functions
// ──────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDelay(minMs, maxMs) {
  const delay = randomInt(minMs, maxMs);
  return sleep(delay);
}

function formatDelay(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

// ──────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────

function validateConfig() {
  const errors = [];

  if (API_IDS.length === 0) errors.push("API_IDS is empty");
  if (API_HASHES.length === 0) errors.push("API_HASHES is empty");
  if (STRING_SESSIONS.length === 0) errors.push("STRING_SESSIONS is empty");
  if (TARGET_BOTS.length === 0) errors.push("TARGET_BOTS is empty");

  if (API_IDS.length > 1 && API_IDS.length !== STRING_SESSIONS.length) {
    errors.push(`API_IDS count (${API_IDS.length}) doesn't match STRING_SESSIONS count (${STRING_SESSIONS.length})`);
  }
  if (API_HASHES.length > 1 && API_HASHES.length !== STRING_SESSIONS.length) {
    errors.push(`API_HASHES count (${API_HASHES.length}) doesn't match STRING_SESSIONS count (${STRING_SESSIONS.length})`);
  }
  if (API_IDS.some(isNaN)) errors.push("API_IDS contains invalid numbers");

  if (errors.length > 0) {
    console.error("❌ Configuration errors:");
    errors.forEach((e) => console.error(`   - ${e}`));
    process.exit(1);
  }

  console.log("✅ Configuration validated");
  console.log(`   Sessions   : ${STRING_SESSIONS.length}`);
  console.log(`   Bots       : ${TARGET_BOTS.length}`);
  console.log(`   Mode       : ${SINGLE_RUN ? "SINGLE_RUN (cron)" : "CONTINUOUS (worker)"}`);
  console.log(`   Anti-ban   : ENABLED`);
}

// ──────────────────────────────────────────────
// Resolve API credentials for a session index
// ──────────────────────────────────────────────

function getApiCredentials(index) {
  const apiId = API_IDS.length === 1 ? API_IDS[0] : API_IDS[index];
  const apiHash = API_HASHES.length === 1 ? API_HASHES[0] : API_HASHES[index];
  return { apiId, apiHash };
}

// ──────────────────────────────────────────────
// Logger helper — suppress verbose GramJS logs
// ──────────────────────────────────────────────

class CustomLogger extends Logger {
  info(msg) {
    if (typeof msg === "string" && msg.length < 200) {
      // Suppress noisy connection logs
    }
  }
  warning(msg) {
    console.warn(`[GramJS WARN] ${msg}`);
  }
  error(msg) {
    console.error(`[GramJS ERR] ${msg}`);
  }
}

// ──────────────────────────────────────────────
// Core: send /start twice to each bot (with anti-ban delays)
// ──────────────────────────────────────────────

async function sendStartCommands(client, sessionLabel) {
  let messageCount = 0;

  // Shuffle bots order for this session (so not all accounts hit same bot first)
  const bots = [...TARGET_BOTS].sort(() => Math.random() - 0.5);

  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i];

    // ── Anti-ban: break after MAX_MESSAGES_BEFORE_BREAK ──
    if (messageCount >= SAFETY.MAX_MESSAGES_BEFORE_BREAK) {
      const breakMs = randomInt(SAFETY.BREAK_MIN_MS, SAFETY.BREAK_MAX_MS);
      console.log(`[${sessionLabel}] ⏸️  Anti-ban break: ${formatDelay(breakMs)} (sent ${messageCount} msgs)`);
      await sleep(breakMs);
      messageCount = 0;
    }

    // ── Anti-ban: delay between different bots ──
    if (i > 0) {
      const botDelay = randomInt(SAFETY.BETWEEN_BOT_MIN_MS, SAFETY.BETWEEN_BOT_MAX_MS);
      console.log(`[${sessionLabel}] ⏳ Waiting ${formatDelay(botDelay)} before next bot…`);
      await sleep(botDelay);
    }

    try {
      // /start #1
      console.log(`[${sessionLabel}] Sending /start #1 → @${bot}`);
      await client.sendMessage(bot, { message: "/start" });
      messageCount++;

      // ── Anti-ban: random delay between the two /start messages ──
      const cmdDelay = randomInt(SAFETY.START_CMD_MIN_MS, SAFETY.START_CMD_MAX_MS);
      await sleep(cmdDelay);

      // /start #2
      console.log(`[${sessionLabel}] Sending /start #2 → @${bot}`);
      await client.sendMessage(bot, { message: "/start" });
      messageCount++;

      console.log(`[${sessionLabel}] ✅ Completed @${bot}`);
    } catch (err) {
      const status = await handleError(err, sessionLabel, bot);
      if (status === "SESSION_DEAD") {
        return "SESSION_DEAD";
      }
    }
  }
  return "OK";
}

// ──────────────────────────────────────────────
// Error handling
// ──────────────────────────────────────────────

async function handleError(err, sessionLabel, bot) {
  const msg = err?.errorMessage || err?.message || String(err);

  // FloodWait — Telegram is telling us to slow down
  if (msg.includes("FloodWait")) {
    const seconds = parseInt(msg.match(/\d+/)?.[0] || "30", 10);
    const waitSec = seconds + randomInt(5, 15); // Add extra buffer for safety
    console.warn(
      `[${sessionLabel}] ⏳ FloodWait ${seconds}s (+${waitSec - seconds}s buffer) on @${bot} — sleeping…`
    );
    await sleep(waitSec * FLOOD_WAIT_MULTIPLIER);
    return "FLOOD_WAIT";
  }

  // ChatWriteForbidden — can't message this bot
  if (msg.includes("CHAT_WRITE_FORBIDDEN") || msg.includes("USER_BANNED_IN_CHANNEL")) {
    console.warn(`[${sessionLabel}] 🚫 Cannot write to @${bot} — skipping`);
    return "SKIP";
  }

  // Bot doesn't exist or is blocked
  if (msg.includes("PEER_ID_INVALID") || msg.includes("BOT_METHOD_INVALID")) {
    console.warn(`[${sessionLabel}] ⚠️  Bot @${bot} not found or blocked — skipping`);
    return "SKIP";
  }

  // Auth key error — session is dead
  if (msg.includes("AUTH_KEY") || msg.includes("SESSION_REVOKED")) {
    console.error(
      `[${sessionLabel}] 🚫 Session invalid / revoked — skipping permanently`
    );
    return "SESSION_DEAD";
  }

  console.error(`[${sessionLabel}] ❌ Error on @${bot}: ${msg}`);
  return "ERROR";
}

// ──────────────────────────────────────────────
// Single-run mode (GitHub Actions cron)
// ──────────────────────────────────────────────

async function runSessionOnce(sessionString, index) {
  const label = `Session-${index + 1}`;
  const { apiId, apiHash } = getApiCredentials(index);
  const stringSession = new StringSession(sessionString);

  // ── Anti-ban: stagger session starts so they don't all connect at once ──
  const staggerMs = randomInt(SAFETY.SESSION_STAGGER_MIN_MS, SAFETY.SESSION_STAGGER_MAX_MS);
  console.log(`[${label}] ⏳ Staggering start: ${formatDelay(staggerMs)}`);
  await sleep(staggerMs);

  console.log(`[${label}] Using API_ID=${apiId}`);

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
    retryDelay: 5000,
    autoReconnect: false,
    timeout: 30000,
    logger: new CustomLogger(),
  });

  try {
    console.log(`[${label}] 🔌 Connecting…`);
    await client.connect();

    if (!client.connected) {
      throw new Error("Failed to connect");
    }

    const me = await client.getMe().catch(() => null);
    if (me) {
      console.log(`[${label}] ✅ Connected as ${me.firstName} (ID: ${me.id})`);
    } else {
      console.log(`[${label}] ✅ Connected`);
    }

    console.log(`[${label}] 🚀 Running /start cycle — ${new Date().toISOString()}`);
    await sendStartCommands(client, label);
    console.log(`[${label}] ✅ Cycle complete`);
  } catch (err) {
    const msg = err?.errorMessage || err?.message || String(err);
    console.error(`[${label}] ❌ Error: ${msg}`);
  } finally {
    try {
      await client.disconnect();
    } catch (_) {}
    console.log(`[${label}] 🔌 Disconnected`);
  }
}

// ──────────────────────────────────────────────
// Continuous mode (Render / always-on hosting)
// ──────────────────────────────────────────────

async function runSessionContinuous(sessionString, index) {
  const label = `Session-${index + 1}`;
  const { apiId, apiHash } = getApiCredentials(index);
  const stringSession = new StringSession(sessionString);
  let dead = false;

  console.log(`[${label}] Using API_ID=${apiId}`);

  while (!dead) {
    const client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 10,
      retryDelay: 5000,
      autoReconnect: true,
      timeout: 30000,
      logger: new CustomLogger(),
    });

    try {
      console.log(`[${label}] 🔌 Connecting…`);
      await client.connect();

      if (!client.connected) {
        throw new Error("Failed to connect");
      }

      const me = await client.getMe().catch(() => null);
      if (me) {
        console.log(`[${label}] ✅ Connected as ${me.firstName} (ID: ${me.id})`);
      } else {
        console.log(`[${label}] ✅ Connected`);
      }

      while (!dead) {
        console.log(`[${label}] 🚀 Starting /start cycle — ${new Date().toISOString()}`);
        const result = await sendStartCommands(client, label);

        if (result === "SESSION_DEAD") {
          dead = true;
          break;
        }

        // ── Anti-ban: add random jitter to sleep time ──
        const jitter = randomInt(SAFETY.LOOP_JITTER_MIN_MS, SAFETY.LOOP_JITTER_MAX_MS);
        const totalSleep = LOOP_INTERVAL_MS + jitter;
        console.log(
          `[${label}] 😴 Sleeping ${formatDelay(totalSleep)} until next cycle (jitter: ${jitter >= 0 ? '+' : ''}${formatDelay(jitter)})…`
        );
        await sleep(totalSleep);
      }
    } catch (err) {
      const msg = err?.errorMessage || err?.message || String(err);

      if (msg.includes("AUTH_KEY") || msg.includes("SESSION_REVOKED")) {
        console.error(`[${label}] 🚫 Session permanently invalid — stopping`);
        dead = true;
        break;
      }

      console.error(`[${label}] ⚠️  Connection error: ${msg}`);
      console.log(`[${label}] 🔄 Reconnecting in 30s…`);
      await sleep(30000);
    } finally {
      try {
        await client.disconnect();
      } catch (_) {}
    }
  }

  console.error(`[${label}] 💀 Session terminated`);
}

// ──────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log(`  Telegram Automation Worker — ${SINGLE_RUN ? "Cron Mode" : "Continuous Mode"}`);
  console.log("═══════════════════════════════════════════");

  validateConfig();

  if (SINGLE_RUN) {
    const promises = STRING_SESSIONS.map((session, i) => runSessionOnce(session, i));
    const results = await Promise.allSettled(promises);

    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`[Session-${i + 1}] Unexpected exit:`, r.reason);
      }
    });

    console.log("✅ Single run complete. Exiting.");
  } else {
    const promises = STRING_SESSIONS.map((session, i) => runSessionContinuous(session, i));
    const results = await Promise.allSettled(promises);

    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`[Session-${i + 1}] Unexpected exit:`, r.reason);
      }
    });

    console.log("All sessions have ended. Process exiting.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
