# Withings → Cloudflare Worker → Intervals

This project implements a **Cloudflare Worker** that receives notifications from Withings, extracts relevant measurements, and automatically sends them to the **Intervals.icu** service.  
The Worker is designed to be modular, scalable, and robust, with OAuth token management, payload validation, automatic retries, and support for manual retry.

---

## 📌 Main Features

- Receives **POST** notifications from Withings (`notify`) and handles subscription (`subscribe`).
- Complete payload validation: `userid`, `startdate`, `enddate`.
- Obtains valid **access token** from KV or automatic refresh.
- Calls Withings API `measure?action=getmeas` to retrieve measurements.
- Extracts configured fields (weight, muscle mass, body fat, etc.).
- Sends data to **Intervals.icu** with automatic retry (2 attempts).
- Saves to KV for manual retry in case of failure.
- **Comprehensive logging system** with detailed operation tracking.
- **Telegram notifications** for successful sends and errors (optional).

---

## ⚡ Installation

1. **Create the Worker** on Cloudflare Workers.
2. **Create KV Namespace** (see Configuration section below)
3. **Configure environment variables** (see Configuration section below)
4. **Deploy the Worker** via Wrangler or Cloudflare UI.
5. **Setup OAuth tokens** for each user (see Initial Setup section below)

---

## 🔧 Configuration

### 1. Cloudflare KV Namespace (Required First)
The Worker needs a KV namespace to store tokens and data:

**How to configure it:**
- In the Cloudflare dashboard, go to Workers → KV
- Click "Create Namespace"
- Assign a name (e.g. `withings-kv`) and click "Create"
- Go back to your Worker, go to Settings → Variables
- Add an environment variable:
  - Variable name: `MY_KV`
  - Value: select the newly created namespace from the dropdown
- Click "Save"

### 2. Withings OAuth Credentials
- `WITHINGS_CLIENT_ID` - Withings OAuth client ID
- `WITHINGS_CLIENT_SECRET` - Withings OAuth client secret

**How to obtain them:**
- Go to [Withings Developer](https://developer.withings.com)
- Register/Login to your account
- Create a new application
- In the app dashboard, copy:
  - Client ID → `WITHINGS_CLIENT_ID`
  - Client Secret → `WITHINGS_CLIENT_SECRET` (keep this value secret)

### 3. Intervals.icu API Credentials
- `INTERVALS_ATHLETE_ID` - Intervals athlete ID
- `INTERVALS_API_KEY` - Intervals API Key

**How to obtain them:**
- Login to your Intervals.icu account
- Go to Settings → API
- Copy your Athlete ID → `INTERVALS_ATHLETE_ID`
- Generate a new API Key → `INTERVALS_API_KEY`

### 4. Telegram Bot Notifications (Optional)
- `TELEGRAM_BOT_TOKEN` - Telegram bot token for notifications
- `TELEGRAM_CHAT_ID` - Telegram chat ID to receive notifications

**How to obtain them:**
- Create a new bot with [@BotFather](https://t.me/botfather) on Telegram
- Send `/newbot` and follow the instructions
- Copy the bot token → `TELEGRAM_BOT_TOKEN`
- Start a chat with your bot and send any message
- Visit `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
- Find your chat ID in the response → `TELEGRAM_CHAT_ID`

---

## 🚀 Initial Setup (One-time per user)

Before the Worker can function, you need to obtain the initial OAuth tokens for each user. This is a **one-time setup** per user.

### Step 1: Get Authorization Code
1. **Visit the OAuth URL:**
   ```
   https://account.withings.com/oauth2_user/authorize2?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=YOUR_REDIRECT_URI&scope=user.metrics&state=random_string
   ```
   - Replace `YOUR_CLIENT_ID` with your actual client ID
   - Replace `YOUR_REDIRECT_URI` with your configured redirect URI
   - The user will be redirected to your redirect URI with a `code` parameter

2. **Extract the code from the redirect URL:**
   - The code will be in the URL parameter: `?code=ABC123...`
   - **⚠️ IMPORTANT:** The authorization code expires in **10 minutes**, so you must use it quickly!

### Step 2: Exchange Code for Tokens
**Execute this command immediately after getting the code:**

```bash
curl -s -X POST "https://wbsapi.withings.net/v2/oauth2" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "action=requesttoken" \
  -d "grant_type=authorization_code" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "code=AUTHORIZATION_CODE" \
  -d "redirect_uri=YOUR_REDIRECT_URI"
```

**Response will contain:**
- `access_token` (expires in 3 hours)
- `refresh_token` (expires in 6 months)
- `expires_in` (seconds until access_token expires)

### Step 3: Store Tokens in KV
Save the response tokens to your Cloudflare KV namespace:

**Key: `token_data_${userid}`**
```json
{
  "access_token": "your_access_token",
  "refresh_token": "your_refresh_token", 
  "expires_at": 1234567890,
  "token_type": "Bearer",
  "updated_at": "2024-01-01T00:00:00.000Z"
}
```

**Key: `refresh_${userid}`**
```
your_refresh_token_string
```

> **Note:** After this initial setup, the Worker handles automatic token refresh. You only need to do this once per user.

### Step 4: Register Webhook with Withings
Configure your webhook URL in the Withings Developer dashboard to point to your Worker URL.

---

## 📝 Project Structure

- `worker.js` → main Worker code
  - `fetch` → HTTP entry point
  - `handleNotify(payload, env)` → async notification processing
  - `getValidAccessToken(userid, env)` → token retrieval with caching
  - `refreshAccessToken(userid, env)` → token refresh with automatic retry
  - Helper functions:
    - `extractConfiguredFields`
    - `sendToIntervals`
    - `getAlreadySentFields`
    - `saveSuccessfulFields`
    - `getNewFieldsToSend`
    - `validatePayload`
- `FIELD_MAPPING` → mapping between Withings and Intervals fields.

---

## 🔧 Payload Validation

Every `notify` payload is validated:

- **userid**: required, numeric.
- **startdate**: optional, default `"0"`, numeric.
- **enddate**: optional, default current timestamp, numeric.
- If the payload is invalid, the Worker responds with **400** and logs the error.

> Detailed comments in the code explain the reasoning behind each check.

---

## 🔄 Token Management

- Tokens stored in KV for each `userid`.
- **Token Expiration Times:**
  - `access_token`: **3 hours** (automatically refreshed by Worker)
  - `refresh_token`: **6 months** (used to get new access_token)
  - `authorization_code`: **10 minutes** (only during initial setup)
- If access_token is expired or missing, **automatic refresh** is performed via refresh_token.
- Automatic retry up to **3 attempts** on error 601 (Too Fast).
- Worker checks token validity with 60-second buffer before expiration.

---

## ✅ Sending Data to Intervals

- Only configured and **new** or modified fields are sent compared to the last send.
- Automatic retry **2 times** if sending fails.
- If all retries fail, data is saved to KV for future manual retry.

---

## 📦 KV Storage

Main keys:

| Key                      | Content                                               |
|--------------------------|------------------------------------------------------|
| `token_data_${userid}`   | Token data with `access_token`, `refresh_token`, `expires_at` |
| `refresh_${userid}`      | Refresh token                                        |
| `sent_${userid}_${grpid}`| Fields already sent for a measurement group         |
| `retry_${userid}_${grpid}` | Data to send manually if retry failed              |

---

## 📱 Telegram Notifications

The Worker can send notifications to Telegram for successful data sends and errors. This is **optional** and requires additional configuration.

### Notification Types

#### **Successful Data Send**
```
✅ Withings Data Sent
👤 User: 12345
⏰ Time: 2024-01-15 12:30:00
📊 Groups: 2

1. 2024-01-15
   Fields: weight, bodyFat
   Values: weight: 75.5, bodyFat: 1.52
   Status: 200

2. 2024-01-14
   Fields: muscleMass
   Values: muscleMass: 45.2
   Status: 200
```

#### **Error Notification**
```
🚨 Withings Worker Error
👤 User: 12345
⏰ Time: 2024-01-15 12:30:00
❌ Error: Token refresh failed
```

#### **No Data Notification**
```
📊 Withings Worker
👤 User: 12345
⏰ Time: 2024-01-15 12:30:00
ℹ️ No data to send
```

### Configuration

Set these environment variables to enable notifications:
- `TELEGRAM_BOT_TOKEN` - Your bot token from @BotFather
- `TELEGRAM_CHAT_ID` - Your chat ID

If these variables are not set, notifications will be disabled automatically.

### Customization

You can modify the notification behavior in the `TELEGRAM_CONFIG` object:
- `enabled: true` - Enable/disable notifications
- `includeData: true` - Include field values in notifications
- `includeErrors: true` - Send notifications for errors

---

## 📊 Logging System

The Worker includes a comprehensive logging system that provides detailed visibility into all operations:

### Log Levels
- **INFO** - Normal operations and successful processing
- **WARN** - Non-critical issues (retries, rate limiting)
- **ERROR** - Critical errors that stop processing

### Log Format
All logs include timestamps and structured data:
```
[2024-01-15T10:30:00.000Z] [INFO] Processing group 12345_1641081600 for date 2024-01-15T00:00:00.000Z
[2024-01-15T10:30:00.100Z] [INFO] Extracted configured fields for 12345_1641081600 {weight: 75.5, bodyFat: 1.52}
[2024-01-15T10:30:00.200Z] [WARN] Intervals send failed attempt 1 for 12345_1641081600 {status: 429, text: "Rate limited"}
```

### What Gets Logged

#### **HTTP Request Processing**
- Request method and payload extraction
- Action validation (subscribe/notify)
- Payload validation results

#### **Token Management**
- Token retrieval from KV
- Token validation and expiration status
- Token refresh operations with retry attempts
- Rate limiting (error 601) handling

#### **Data Processing**
- Withings API calls and responses
- Number of measurement groups found
- Individual group processing
- Field extraction and unit conversions
- Duplicate detection (already sent fields)

#### **Intervals Integration**
- Send attempts and results
- Retry operations with delays
- Success/failure status
- Manual retry data storage

### Example Log Flow
Here's what a typical successful processing looks like:

```
[2024-01-15T10:30:00.000Z] [INFO] Incoming POST request
[2024-01-15T10:30:00.100Z] [INFO] Payload extracted from formData {userid: "12345", action: "notify", startdate: "1640995200", enddate: "1641081600"}
[2024-01-15T10:30:00.200Z] [INFO] Validating payload {userid: "12345", startdate: "1640995200", enddate: "1641081600"}
[2024-01-15T10:30:00.300Z] [INFO] Payload validation successful
[2024-01-15T10:30:00.400Z] [INFO] Starting async processing with ctx.waitUntil
[2024-01-15T10:30:00.500Z] [INFO] Starting handleNotify for userid: 12345, startdate: 1640995200, enddate: 1641081600
[2024-01-15T10:30:00.600Z] [INFO] Getting valid access token for userid: 12345
[2024-01-15T10:30:00.700Z] [INFO] Valid token found in KV for userid: 12345, expires in 7200 seconds
[2024-01-15T10:30:00.800Z] [INFO] Calling Withings API for userid: 12345
[2024-01-15T10:30:01.000Z] [INFO] Withings API response status: 0
[2024-01-15T10:30:01.100Z] [INFO] Found 2 measurement groups
[2024-01-15T10:30:01.200Z] [INFO] Processing group 12345_1641081600 for date 2024-01-15T00:00:00.000Z
[2024-01-15T10:30:01.300Z] [INFO] Processed measures for 12345_1641081600 [{type: 1, value: 75.5, unit: 0}, {type: 6, value: 15.2, unit: 1}]
[2024-01-15T10:30:01.400Z] [INFO] Extracted configured fields for 12345_1641081600 {weight: 75.5, bodyFat: 1.52}
[2024-01-15T10:30:01.500Z] [INFO] Already sent fields for 12345_1641081600 {}
[2024-01-15T10:30:01.600Z] [INFO] New fields to send for 12345_1641081600 {weight: 75.5, bodyFat: 1.52}
[2024-01-15T10:30:01.700Z] [INFO] Starting Intervals send for 12345_1641081600 with 2 fields
[2024-01-15T10:30:01.800Z] [INFO] Sending to Intervals (attempt 1) for 12345_1641081600
[2024-01-15T10:30:02.000Z] [INFO] Successfully sent to Intervals for 12345_1641081600, status: 200
```

### Error Log Examples
Here's what error scenarios look like:

**Token Refresh Error:**
```
[2024-01-15T10:30:00.000Z] [INFO] Refreshing access token for userid: 12345 (attempt 1)
[2024-01-15T10:30:00.100Z] [WARN] Rate limited (601), waiting 10 seconds before retry 1
[2024-01-15T10:30:10.200Z] [INFO] Token refresh successful for userid: 12345, expires in 10800 seconds
```

**Intervals Send Failure:**
```
[2024-01-15T10:30:00.000Z] [INFO] Sending to Intervals (attempt 1) for 12345_1641081600
[2024-01-15T10:30:00.100Z] [WARN] Intervals send failed attempt 1 for 12345_1641081600 {status: 429, text: "Rate limited"}
[2024-01-15T10:30:00.200Z] [INFO] Retrying in 2 seconds for 12345_1641081600
[2024-01-15T10:30:02.300Z] [INFO] Sending to Intervals (attempt 2) for 12345_1641081600
[2024-01-15T10:30:02.400Z] [ERROR] All retries failed for 12345_1641081600, saving for manual retry
```

**Payload Validation Error:**
```
[2024-01-15T10:30:00.000Z] [INFO] Validating payload {userid: "invalid", startdate: "1640995200", enddate: "1641081600"}
[2024-01-15T10:30:00.100Z] [ERROR] Payload validation error Invalid userid
```

### Monitoring Recommendations
- Monitor logs for **ERROR** level messages
- Watch for frequent **WARN** messages (may indicate issues)
- Track successful processing patterns
- Use logs for debugging data flow issues
- Set up alerts for critical errors

---

## ⚠️ Error Handling

- All errors are logged to console with detailed context.
- Main flows are not blocked by errors: the Worker responds immediately to Withings.
- Automatic retries managed for tokens and Intervals sending.
- Persistent data saved for manual retry if necessary.
- Comprehensive error logging helps with troubleshooting.

---

## 🌐 General Flow

### Initial Setup Flow
1. **OAuth Authorization** → User authorizes your app via Withings OAuth
2. **Token Exchange** → Exchange authorization code for access/refresh tokens
3. **Token Storage** → Store tokens in Cloudflare KV for each user
4. **Webhook Registration** → Withings calls your Worker URL for notifications

### Runtime Flow (After Setup)
1. HTTP request → HEAD or POST
2. `subscribe` → immediate response `{status:0}`
3. `notify` → payload validation
4. Immediate response `"OK"` + `ctx.waitUntil(handleNotify)`
5. Retrieve valid access token (KV cache or refresh)
6. Call Withings API `getmeas`
7. Process groups and measure configured fields
8. Check already sent → send new fields to Intervals
9. Automatic retry on failed send → save to KV for manual retry
10. Complete logging at every step

---

## 🛠️ Tips

- Update `FIELD_MAPPING` to add new Withings fields.
- **Monitor Worker logs** for any errors or retries using the comprehensive logging system.
- **Set up log monitoring** to catch issues early (ERROR level alerts).
- **Use log data** to optimize field mapping and identify frequently sent data.
- **Track retry patterns** to identify potential API issues.
- Periodic KV cleanup recommended to avoid old data accumulation.
- **Debug data flow** using the detailed processing logs.

---

## 📄 License

Open-source project. Modification and reuse allowed.

