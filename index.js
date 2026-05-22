const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Logger } = require("telegram/extensions/Logger");

// ──────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────

// Support per-session API credentials
// Format: API_IDS=id1|id2|id3  API_HASHES=hash1|hash2|hash3  STRING_SESSIONS=sess1|sess2|sess3
// If only one API_ID/API_HASH is provided, it's used for all sessions.
const API_IDS = (process.env.API_IDS || "").split("|").filter(Boolean).map(Number);
const API_HASHES = (process.env.API_HASHES || "").split("|").filter(Boolean);
const STRING_SESSIONS = (process.env.STRING_SESSIONS || "").split("|").filter(Boolean);
const TARGET_BOTS = (process.env.TARGET_BOTS || "").split("|").filter(Boolean);
const SINGLE_RUN = (process.env.SINGLE_RUN || "").toLowerCase() === "true";
const LOOP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const START_COMMAND_DELAY_MS = 3000; // 3-second gap between the two /start messages
const FLOOD_WAIT_MULTIPLIER = 1000; // convert seconds to ms

// ──────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────

function validateConfig() {
  const errors = [];

  if (API_IDS.length === 0) errors.push("API_IDS is empty");
  if (API_HASHES.length === 0) errors.push("API_HASHES is empty");
  if (STRING_SESSIONS.length === 0) errors.push("STRING_SESSIONS is empty");
  if (TARGET_BOTS.length === 0) errors.push("TARGET_BOTS is empty");

  // If multiple API_IDs/HASHes, count must match sessions
  if (API_IDS.length > 1 && API_IDS.length !== STRING_SESSIONS.length) {
    errors.push(`API_IDS count (${API_IDS.length}) doesn't match STRING_SESSIONS count (${STRING_SESSIONS.length})`);
  }
  if (API_HASHES.length > 1 && API_HASHES.length !== STRING_SESSIONS.length) {
    errors.push(`API_HASHES count (${API_HASHES.length}) doesn't match STRING_SESSIONS count (${STRING_SESSIONS.length})`);
  }
  // Validate API_IDS are valid numbers
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
}

// ──────────────────────────────────────────────
// Resolve API credentials for a session index
// ──────────────────────────────────────────────

function getApiCredentials(index) {
  // If only one value, reuse for all sessions
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
      console.log(`[GramJS] ${msg}`);
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
// Core: send /start twice to each bot
// ──────────────────────────────────────────────

async function sendStartCommands(client, sessionLabel) {
  for (const bot of TARGET_BOTS) {
    try {
      console.log(`[${sessionLabel}] Sending /start #1 → @${bot}`);
      await client.sendMessage(bot, { message: "/start" });

      await sleep(START_COMMAND_DELAY_MS);

      console.log(`[${sessionLabel}] Sending /start #2 → @${bot}`);
      await client.sendMessage(bot, { message: "/start" });

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

  // FloodWait
  if (msg.includes("FloodWait")) {
    const seconds = parseInt(msg.match(/\d+/)?.[0] || "30", 10);
    console.warn(
      `[${sessionLabel}] ⏳ FloodWait ${seconds}s on @${bot} — sleeping…`
    );
    await sleep(seconds * FLOOD_WAIT_MULTIPLIER);
    return "FLOOD_WAIT";
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
// Single-run mode: connect → send → disconnect → exit
// Used by GitHub Actions cron
// ──────────────────────────────────────────────

async function runSessionOnce(sessionString, index) {
  const label = `Session-${index + 1}`;
  const { apiId, apiHash } = getApiCredentials(index);
  const stringSession = new StringSession(sessionString);

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
// Continuous mode: connect → loop forever → reconnect
// Used by Render / always-on hosting
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

        console.log(`[${label}] 😴 Sleeping ${LOOP_INTERVAL_MS / 1000}s until next cycle…`);
        await sleep(LOOP_INTERVAL_MS);
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
// Utility
// ──────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    // ── Cron / GitHub Actions mode ──
    // Run once for all sessions, then exit
    const promises = STRING_SESSIONS.map((session, i) => runSessionOnce(session, i));
    const results = await Promise.allSettled(promises);

    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`[Session-${i + 1}] Unexpected exit:`, r.reason);
      }
    });

    console.log("✅ Single run complete. Exiting.");
  } else {
    // ── Continuous / Worker mode ──
    // Each session runs in its own infinite loop
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
