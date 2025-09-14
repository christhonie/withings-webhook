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
- Detailed logging of all operations.

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

## ⚠️ Error Handling

- All errors are logged to console.
- Main flows are not blocked by errors: the Worker responds immediately to Withings.
- Automatic retries managed for tokens and Intervals sending.
- Persistent data saved for manual retry if necessary.

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
- Monitor Worker logs for any errors or retries.
- Periodic KV cleanup recommended to avoid old data accumulation.

---

## 📄 License

Open-source project. Modification and reuse allowed.

