# Telegram Automation Worker

A production-ready Node.js background worker that sends `/start` to target Telegram bots on a recurring schedule using GramJS string sessions. Designed for 24/7 deployment on Render.com.

---

## Features

- Sends `/start` **twice** to each target bot (with a 3-second delay between messages)
- Repeats every **1 hour** automatically
- Supports **multiple string sessions** running in parallel
- Supports **multiple target bots**
- Auto-reconnects on disconnect
- Handles `FloodWait` gracefully (sleeps the required duration)
- Never crashes on a single failed session — each session runs independently
- Zero OTP required after initial string session generation

---

## Prerequisites

- Node.js 18+
- Telegram API credentials from [my.telegram.org](https://my.telegram.org)
- One or more GramJS string sessions (see below)

---

## How to Generate a String Session

You need a one-time login to create a string session. After that, no OTP is ever required again.

### Option A — Using GramJS CLI (Recommended)

```bash
npx telegram# This will prompt for phone, OTP, and 2FA — then print your string session
```

### Option B — Quick Script

Create a temporary file `gen-session.js`:

```js
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

const apiId = 12345678;            // your API_ID
const apiHash = "your_api_hash";   // your API_HASH

(async () => {
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.start({
    phoneNumber: async () => await input.text("Phone number? "),
    password: async () => await input.text("2FA password? "),
    phoneCode: async () => await input.text("Code? "),
    onError: (err) => console.error(err),
  });
  console.log("YOUR STRING SESSION:");
  console.log(client.session.save());
  await client.disconnect();
})();
```

```bash
npm install telegram input
node gen-session.js
```

Copy the printed session string. **Delete the script afterwards.**

> ⚠️ **Security**: Never share your string session. It grants full access to your Telegram account.

---

## Local Development

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/telegram-automation-worker.git
cd telegram-automation-worker
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create `.env` file

```bash
cp .env.example .env
```

Edit `.env` with your actual values:

```env
API_ID=12345678
API_HASH=your_api_hash_here
STRING_SESSIONS=session1|session2|session3
TARGET_BOTS=bot1|bot2|bot3
```

### 4. Run

```bash
npm start
```

---

## Deploy to Render.com

### Step 1 — Push to GitHub

Ensure your project is pushed to a GitHub repository.

### Step 2 — Create a new Background Worker

1. Go to [dashboard.render.com](https://dashboard.render.com)
2. Click **New** → **Background Worker**
3. Connect your GitHub repository
4. Configure:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`
   - **Plan**: Free (or Starter for always-on)

### Step 3 — Add Environment Variables

In the Render dashboard, add these environment variables:

| Variable | Description | Example |
|---|---|---|
| `API_ID` | Telegram API ID | `12345678` |
| `API_HASH` | Telegram API Hash | `abc123def456` |
| `STRING_SESSIONS` | Pipe-separated session strings | `sess1\|sess2\|sess3` |
| `TARGET_BOTS` | Pipe-separated bot usernames | `bot1\|bot2\|bot3` |

### Step 4 — Deploy

Click **Create Background Worker**. Render will build and start the worker automatically.

### Alternative — Using render.yaml (Blueprint)

This repository includes a `render.yaml` file. You can use Render Blueprints:

1. Go to [dashboard.render.com](https://dashboard.render.com)
2. Click **New** → **Blueprint**
3. Connect your repository
4. Render will auto-detect `render.yaml` and configure the worker
5. Fill in the environment variables in the dashboard
6. Click **Apply**

---

## Environment Variables Reference

| Variable | Required | Format | Description |
|---|---|---|---|
| `API_ID` | ✅ | Integer | Your Telegram API ID from my.telegram.org |
| `API_HASH` | ✅ | String | Your Telegram API Hash from my.telegram.org |
| `STRING_SESSIONS` | ✅ | `s1\|s2\|s3` | Pipe-separated GramJS string sessions |
| `TARGET_BOTS` | ✅ | `b1\|b2\|b3` | Pipe-separated target bot usernames (without @) |

---

## Important Notes

- **String sessions are secrets** — they provide full access to your Telegram account. Never commit them to Git or share them publicly.
- **API credentials are secrets** — keep `API_ID` and `API_HASH` private.
- The `.env` file is listed in `.gitignore` and will never be committed.
- On Render's **free plan**, workers spin down after inactivity. Use a paid plan for true 24/7 operation.
- Each session runs independently — if one session fails, the others continue running.
- `FloodWait` errors are handled automatically by sleeping the required duration.

---

## License

MIT
