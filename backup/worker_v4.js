// Withings -> Cloudflare Worker -> Intervals (modulare, con retry automatici)
// Questo Worker riceve notifiche Withings, valida il payload, gestisce token OAuth,
// recupera misure, estrae campi configurati, invia a Intervals, e gestisce eventuali errori/retry.

export default {
  async fetch(request, env, ctx) {
    // 🔹 Controllo tipo di richiesta HTTP
    // HEAD → usato per check di salute
    if (request.method === "HEAD") return new Response("OK", { status: 200 });

    // Solo POST è consentito, altrimenti errore 400
    if (request.method !== "POST") return new Response("Withings Worker: use POST", { status: 400 });

    // 🔹 Estrazione payload da formData inviato da Withings
    const form = await request.formData();
    const payload = Object.fromEntries(form);

    // 🔹 Gestione subscribe (usato da Withings per registrazione callback)
    if (payload.action === "subscribe") {
      return new Response(JSON.stringify({ status: 0 }), { headers: { "Content-Type": "application/json" }});
    }

    // 🔹 Controllo action "notify" → solo notify può procedere
    if (payload.action !== "notify") {
      return new Response("Unsupported action", { status: 400 });
    }

    try {
      // 🔹 Validazione payload: userid numerico, startdate numerico, enddate numerico e coerente
      validatePayload(payload);

      // 🔹 Risposta immediata a Withings per evitare timeout
      // ctx.waitUntil permette di continuare il processing async senza bloccare la risposta
      ctx.waitUntil(handleNotify(payload, env));
      return new Response("OK", { status: 200 });

    } catch (err) {
      // 🔹 Se il payload non è valido, log e ritorna errore 400
      console.error("Payload validation error:", err);
      return new Response("Invalid payload: " + err.message, { status: 400 });
    }
  }
};

// 🔧 Funzione di validazione payload
function validatePayload(payload) {
  // Controlla che userid sia presente e numerico
  const userid = payload.userid;
  if (!userid || typeof userid !== 'string' || !/^\d+$/.test(userid)) {
    throw new Error('Invalid userid');
  }

  // Controlla che startdate sia numerico (default 0 se mancante)
  const startdate = payload.startdate || "0";
  if (!/^\d+$/.test(startdate)) {
    throw new Error('Invalid startdate');
  }

  // Controlla enddate numerico e maggiore o uguale a startdate
  const enddate = payload.enddate || Math.floor(Date.now()/1000).toString();
  if (!/^\d+$/.test(enddate) || Number(enddate) < Number(startdate)) {
    throw new Error('Invalid enddate');
  }

  // Aggiorna payload con valori validati
  payload.userid = userid;
  payload.startdate = startdate;
  payload.enddate = enddate;
}

// 🔧 Configurazione mapping Withings -> Intervals
// Contiene tutti i tipi di misura Withings e come convertirli in campi Intervals
const FIELD_MAPPING = {
  weight: { withingsType: 1, intervalsField: 'weight', decimals: 3 },
  bodyFat: { withingsType: 6, intervalsField: 'bodyFat', decimals: 2 },
  muscleMass: { withingsType: 76, intervalsField: 'WithingsMuscleMass', decimals: 2 },
  waterMass: { withingsType: 77, intervalsField: 'WithingsWaterMass', decimals: 2 },
  boneMass: { withingsType: 88, intervalsField: 'WithingsBoneMass', decimals: 3 },
  leanMass: { withingsType: 5, intervalsField: 'WithingsLeanMass', decimals: 2 },
  visceralFat: { withingsType: 170, intervalsField: 'WithingsVisceralFat', decimals: 1 },
  bmr: { withingsType: 226, intervalsField: 'WithingsBMR', decimals: 0 },
  metabolicAge: { withingsType: 227, intervalsField: 'WithingsMetabolicAge', decimals: 0 },
};

// 🔧 Ottieni token valido da KV o tramite refresh se scaduto
// Retry automatico incluso in caso di errore 601
async function getValidAccessToken(userid, env) {
  const tokenKey = `token_data_${userid}`;
  try {
    const tokenDataStr = await env.MY_KV.get(tokenKey);
    if (tokenDataStr) {
      const tokenData = JSON.parse(tokenDataStr);
      const now = Math.floor(Date.now() / 1000);
      // Se token valido con buffer 60s, ritorna subito
      if (tokenData.expires_at && now < tokenData.expires_at - 60) {
        return tokenData.access_token;
      }
    }
    // Token mancante o scaduto → refresh
    return await refreshAccessToken(userid, env);
  } catch (err) {
    console.error("getValidAccessToken error:", err);
    throw err;
  }
}

// 🔧 Refresh token con retry automatico fino a 3 tentativi su errore 601
async function refreshAccessToken(userid, env, retryCount = 0) {
  const refreshKey = `refresh_${userid}`;
  const tokenKey = `token_data_${userid}`;

  const refreshToken = await env.MY_KV.get(refreshKey);
  if (!refreshToken) throw new Error(`No refresh token for userid ${userid}`);

  const tokenResp = await fetch("https://wbsapi.withings.net/v2/oauth2", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      action: "requesttoken",
      grant_type: "refresh_token",
      client_id: env.WITHINGS_CLIENT_ID,
      client_secret: env.WITHINGS_CLIENT_SECRET,
      refresh_token: refreshToken
    })
  });

  const tokenJson = await tokenResp.json();

  // Retry intelligente su errore 601
  if (tokenJson.status === 601 && retryCount < 3) {
    const waitSeconds = tokenJson.body?.wait_seconds || 10;
    await new Promise(res => setTimeout(res, waitSeconds * 1000));
    return refreshAccessToken(userid, env, retryCount + 1);
  }

  if (tokenJson.status !== 0 || !tokenJson.body?.access_token) {
    throw new Error(`Refresh token failed: ${JSON.stringify(tokenJson)}`);
  }

  const tokenData = {
    access_token: tokenJson.body.access_token,
    refresh_token: tokenJson.body.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + tokenJson.body.expires_in,
    token_type: tokenJson.body.token_type,
    updated_at: new Date().toISOString()
  };

  await env.MY_KV.put(tokenKey, JSON.stringify(tokenData));
  await env.MY_KV.put(refreshKey, tokenJson.body.refresh_token);

  return tokenJson.body.access_token;
}

// 🔧 Elaborazione notify con retry automatico anche per Intervals
async function handleNotify(payload, env) {
  const { userid, startdate, enddate } = payload;

  try {
    // 🔹 Ottieni access token valido
    const accessToken = await getValidAccessToken(userid, env);

    // 🔹 Recupera misure Withings
    const params = new URLSearchParams({ action: "getmeas", startdate, enddate });
    const measResp = await fetch("https://wbsapi.withings.net/measure", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });

    const measJson = await measResp.json();
    if (!measJson || measJson.status !== 0 || !measJson.body) return;

    const groups = measJson.body.measuregrps || [];
    if (!groups.length) return;

    for (const grp of groups) {
      const grpid = grp.grpid || `${userid}_${grp.date}`;
      const date_iso = new Date(grp.date * 1000).toISOString();

      // 🔹 Processa le misure: calcola valore corretto con unit
      const processed = {
        userid,
        grpid,
        date_iso,
        measures: grp.measures.map(m => ({
          type: Number(m.type),
          raw_value: m.value,
          unit: Number(m.unit),
          value: Number(m.value) * Math.pow(10, Number(m.unit))
        }))
      };

      // 🔹 Estrai campi configurati
      const extractedData = extractConfiguredFields(processed.measures);
      if (!Object.keys(extractedData).length) continue;

      // 🔹 Determina quali campi sono nuovi
      const alreadySent = await getAlreadySentFields(userid, grpid, env);
      const newFields = getNewFieldsToSend(extractedData, alreadySent);
      if (!Object.keys(newFields).length) continue;

      // 🔹 Retry automatico invio Intervals fino a 2 tentativi
      let attempts = 0;
      let sent = false;
      while (attempts < 2 && !sent) {
        const sendRes = await sendToIntervals({ date_iso, wellnessData: newFields }, env);
        if (sendRes.ok) {
          await saveSuccessfulFields(userid, grpid, newFields, sendRes.status, env);
          sent = true;
        } else {
          console.warn(`Intervals send failed attempt ${attempts + 1}:`, sendRes.status);
          attempts++;
          if (attempts < 2) await new Promise(r => setTimeout(r, 2000)); // breve delay tra retry
        }
      }

      // 🔹 Se ancora fallito → salva KV per retry manuale futuro
      if (!sent) {
        await env.MY_KV.put(`retry_${userid}_${grpid}`, JSON.stringify({
          attemptAt: new Date().toISOString(),
          fields: newFields
        }));
      }
    }

  } catch (err) {
    console.error("handleNotify error:", err);
  }
}

// 🔧 Utility functions
function extractConfiguredFields(measures) {
  const extracted = {};
  for (const [fieldName, config] of Object.entries(FIELD_MAPPING)) {
    const measure = measures.find(m => m.type === config.withingsType);
    if (measure?.value != null) extracted[fieldName] = Number(measure.value.toFixed(config.decimals));
  }
  return extracted;
}

async function getAlreadySentFields(userid, grpid, env) {
  const sentKey = `sent_${userid}_${grpid}`;
  const existing = await env.MY_KV.get(sentKey);
  if (!existing) return {};
  try { return JSON.parse(existing).fields || {}; } catch { return {}; }
}

function getNewFieldsToSend(extractedData, alreadySent) {
  const newFields = {};
  for (const [fieldName, value] of Object.entries(extractedData)) {
    if (!(fieldName in alreadySent) || alreadySent[fieldName] !== value) {
      newFields[fieldName] = value;
    }
  }
  return newFields;
}

// 🔧 Salva campi inviati con successo
async function saveSuccessfulFields(userid, grpid, newFields, status, env) {
  const sentKey = `sent_${userid}_${grpid}`;
  const existing = await getAlreadySentFields(userid, grpid, env);
  const allFields = { ...existing, ...newFields };
  await env.MY_KV.put(sentKey, JSON.stringify({
    lastSentAt: new Date().toISOString(),
    status,
    fields: allFields
  }));
}

// 🔧 Invia dati a Intervals
async function sendToIntervals({ date_iso, wellnessData }, env) {
  const date = date_iso.slice(0,10); // YYYY-MM-DD
  const athleteId = env.INTERVALS_ATHLETE_ID;
  const apiKey = env.INTERVALS_API_KEY;
  const url = `https://intervals.icu/api/v1/athlete/${athleteId}/wellness/${date}`;
  const intervalsPayload = {};
  for (const [fieldName, value] of Object.entries(wellnessData)) {
    const config = FIELD_MAPPING[fieldName];
    if (config) intervalsPayload[config.intervalsField] = value;
  }

  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + btoa(`API_KEY:${apiKey}`)
    },
    body: JSON.stringify(intervalsPayload)
  });

  const text = await resp.text();
  return { ok: resp.ok, status: resp.status, text };
}
