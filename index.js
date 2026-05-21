const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Logger } = require("telegram/extensions/Logger");

// ──────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────

const API_ID = parseInt(process.env.API_ID, 10);
const API_HASH = process.env.API_HASH;
const STRING_SESSIONS = (process.env.STRING_SESSIONS || "").split("|").filter(Boolean);
const TARGET_BOTS = (process.env.TARGET_BOTS || "").split("|").filter(Boolean);
const LOOP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const START_COMMAND_DELAY_MS = 3000; // 3-second gap between the two /start messages
const FLOOD_WAIT_MULTIPLIER = 1000; // convert seconds to ms

// ──────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────

function validateConfig() {
  const errors = [];
  if (!API_ID || isNaN(API_ID)) errors.push("API_ID is missing or invalid");
  if (!API_HASH) errors.push("API_HASH is missing");
  if (STRING_SESSIONS.length === 0) errors.push("STRING_SESSIONS is empty");
  if (TARGET_BOTS.length === 0) errors.push("TARGET_BOTS is empty");

  if (errors.length > 0) {
    console.error("❌ Configuration errors:");
    errors.forEach((e) => console.error(`   - ${e}`));
    process.exit(1);
  }

  console.log("✅ Configuration validated");
  console.log(`   Sessions : ${STRING_SESSIONS.length}`);
  console.log(`   Bots     : ${TARGET_BOTS.length}`);
}

// ──────────────────────────────────────────────
// Logger helper — suppress verbose GramJS logs
// ──────────────────────────────────────────────

class CustomLogger extends Logger {
  info(msg) {
    // only surface important messages
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

function handleError(err, sessionLabel, bot) {
  const msg = err?.errorMessage || err?.message || String(err);

  // FloodWait
  if (msg.includes("FloodWait")) {
    const seconds = parseInt(msg.match(/\d+/)?.[0] || "30", 10);
    console.warn(
      `[${sessionLabel}] ⏳ FloodWait ${seconds}s on @${bot} — sleeping…`
    );
    return sleep(seconds * FLOOD_WAIT_MULTIPLIER);
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
// Run one session continuously
// ──────────────────────────────────────────────

async function runSession(sessionString, index) {
  const label = `Session-${index + 1}`;
  const stringSession = new StringSession(sessionString);
  let dead = false;

  while (!dead) {
    const client = new TelegramClient(stringSession, API_ID, API_HASH, {
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
        console.log(
          `[${label}] ✅ Connected as ${me.firstName} (ID: ${me.id})`
        );
      } else {
        console.log(`[${label}] ✅ Connected (could not fetch user info)`);
      }

      // Main loop
      while (!dead) {
        console.log(`[${label}] 🚀 Starting /start cycle — ${new Date().toISOString()}`);
        const result = await sendStartCommands(client, label);

        if (result === "SESSION_DEAD") {
          dead = true;
          break;
        }

        console.log(
          `[${label}] 😴 Sleeping ${LOOP_INTERVAL_MS / 1000}s until next cycle…`
        );
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
      } catch (_) {
        // ignore
      }
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
  console.log("  Telegram Automation Worker — Started");
  console.log("═══════════════════════════════════════════");

  validateConfig();

  // Launch all sessions in parallel — each runs its own infinite loop
  const promises = STRING_SESSIONS.map((session, i) => runSession(session, i));

  // If any session throws unexpectedly, we still keep the others alive
  const results = await Promise.allSettled(promises);

  // Log final state
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`[Session-${i + 1}] Unexpected exit:`, r.reason);
    }
  });

  console.log("All sessions have ended. Process exiting.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
