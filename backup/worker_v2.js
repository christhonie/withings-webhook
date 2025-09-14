// Withings -> Cloudflare Worker -> Intervals (modulare e scalabile)
export default {
  async fetch(request, env, ctx) {
    if (request.method === "HEAD") return new Response("OK", { status: 200 });
    if (request.method !== "POST") return new Response("Withings Worker: use POST", { status: 200 });

    const form = await request.formData();
    const payload = Object.fromEntries(form);

    // Withings subscribe test
    if (payload.action === "subscribe") {
      return new Response(JSON.stringify({ status: 0 }), { headers: { "Content-Type": "application/json" }});
    }

    // rispondi subito e processa async
    ctx.waitUntil(handleNotify(payload, env));
    return new Response("OK", { status: 200 });
  }
};

// Configurazione mapping Withings -> Intervals
const FIELD_MAPPING = {
  weight: { withingsType: 1, intervalsField: 'weight', decimals: 3 },
  bodyFat: { withingsType: 6, intervalsField: 'bodyFat', decimals: 2 },
  
  // 🆕 Aggiungi altri campi semplicemente decommentando (nomi esatti Intervals):
  muscleMass: { withingsType: 76, intervalsField: 'WithingsMuscleMass', decimals: 2 },
  waterMass: { withingsType: 77, intervalsField: 'WithingsWaterMass', decimals: 2 },
  boneMass: { withingsType: 88, intervalsField: 'WithingsBoneMass', decimals: 3 },
  leanMass: { withingsType: 5, intervalsField: 'WithingsLeanMass', decimals: 2 },
  visceralFat: { withingsType: 170, intervalsField: 'WithingsVisceralFat', decimals: 1 },
  bmr: { withingsType: 226, intervalsField: 'WithingsBMR', decimals: 0 },
  metabolicAge: { withingsType: 227, intervalsField: 'WithingsMetabolicAge', decimals: 0 },
};

async function handleNotify(payload, env) {
  try {
    const userid = payload.userid;
    const startdate = payload.startdate || "0";
    const enddate = payload.enddate || Math.floor(Date.now()/1000).toString();

    if (!userid) {
      console.warn("notify senza userid:", payload);
      return;
    }

    // 1) prendi refresh token da KV (chiave: refresh_<userid>)
    const refreshKey = `refresh_${userid}`;
    let refreshToken = await env.MY_KV.get(refreshKey);
    if (!refreshToken) {
      console.error("Nessun refresh token per userid:", userid);
      return;
    }

    // 2) scambia refresh_token -> access_token (rotazione)
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
    if (!tokenJson || tokenJson.status !== 0 || !tokenJson.body?.access_token) {
      console.error("Errore durante refresh token:", JSON.stringify(tokenJson));
      return;
    }
    const accessToken = tokenJson.body.access_token;
    const newRefresh = tokenJson.body.refresh_token;
    // aggiorna KV con nuovo refresh token
    await env.MY_KV.put(refreshKey, newRefresh);

    // 3) chiama measure?action=getmeas per ottenere le misure effettive
    const params = new URLSearchParams({
      action: "getmeas",
      startdate: startdate,
      enddate: enddate
    });
    const measResp = await fetch("https://wbsapi.withings.net/measure", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });
    const measJson = await measResp.json();
    
    // DEBUG Subito dopo measJson = await measResp.json();
    console.log("🔍 Debug Withings API response:", {
    status: measJson.status,
    error: measJson.error,
    body: measJson.body ? {
      measuregrps_count: measJson.body.measuregrps?.length || 0,
      measuregrps: measJson.body.measuregrps
    } : "no body"
    });
    
    if (!measJson || measJson.status !== 0) {
      console.error("Errore getmeas:", JSON.stringify(measJson));
      return;
    }

    const groups = measJson.body?.measuregrps || [];
    if (groups.length === 0) {
      console.log("Nessun measuregrps per", userid, "range", startdate, enddate);
      return;
    }

    // 4) per ogni group: estrai tutti i campi configurati
    for (const grp of groups) {
      const grpid = grp.grpid || `${userid}_${grp.date}`;
      const date_iso = new Date(grp.date * 1000).toISOString();
      
      // costruisci oggetto processed leggibile
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

      console.log("Misure processate:", JSON.stringify(processed));

      // Estrai tutti i campi configurati
      const extractedData = extractConfiguredFields(processed.measures);
      
      if (Object.keys(extractedData).length === 0) {
        console.log("Nessun dato configurato da inviare per grpid", grpid);
        continue;
      }

      // Controlla cosa è già stato inviato per questo gruppo
      const alreadySent = await getAlreadySentFields(userid, grpid, env);
      const newFields = getNewFieldsToSend(extractedData, alreadySent);
      
      if (Object.keys(newFields).length === 0) {
        console.log("Tutti i campi già inviati per grpid", grpid);
        continue;
      }

      console.log("Nuovi campi da inviare:", newFields);

      // 5) invia a Intervals
      const sendRes = await sendToIntervals({ date_iso, wellnessData: newFields }, env);
      if (sendRes.ok) {
        // Salva i campi inviati con successo
        await saveSuccessfulFields(userid, grpid, newFields, sendRes.status, env);
        console.log("Inviato a Intervals:", grpid, sendRes.status, "campi:", Object.keys(newFields));
      } else {
        console.error("Invio Intervals fallito", sendRes);
        await env.MY_KV.put(`retry_${userid}_${grpid}`, JSON.stringify({ 
          attemptAt: new Date().toISOString(), 
          fields: newFields,
          res: { status: sendRes.status, text: sendRes.text }
        }));
      }
    }

  } catch (err) {
    console.error("Errore handleNotify:", err);
  }
}

// Raggruppa le misure per data (per calcolare medie giornaliere)
function groupMeasuresByDate(groups) {
  const grouped = {};
  
  for (const grp of groups) {
    const dateKey = grp.date.toString(); // timestamp unix come chiave
    if (!grouped[dateKey]) {
      grouped[dateKey] = [];
    }
    grouped[dateKey].push(grp);
  }
  
  return grouped;
}

// Calcola le medie di tutti i campi per le rilevazioni dello stesso giorno
function calculateDayAverages(dayGroups) {
  const fieldSums = {};
  const fieldCounts = {};
  
  // Raccoglie tutti i valori per campo
  for (const grp of dayGroups) {
    const measures = grp.measures.map(m => ({
      type: Number(m.type),
      raw_value: m.value,
      unit: Number(m.unit),
      value: Number(m.value) * Math.pow(10, Number(m.unit))
    }));
    
    // Estrai campi configurati per questo gruppo
    const fields = extractConfiguredFields(measures);
    
    for (const [fieldName, value] of Object.entries(fields)) {
      if (!fieldSums[fieldName]) {
        fieldSums[fieldName] = 0;
        fieldCounts[fieldName] = 0;
      }
      fieldSums[fieldName] += value;
      fieldCounts[fieldName]++;
    }
  }
  
  // Calcola medie
  const averages = {};
  for (const [fieldName, sum] of Object.entries(fieldSums)) {
    const config = FIELD_MAPPING[fieldName];
    const average = sum / fieldCounts[fieldName];
    averages[fieldName] = Number(average.toFixed(config.decimals));
  }
  
  return averages;
}

// Estrai tutti i campi configurati dalle misure
function extractConfiguredFields(measures) {
  const extracted = {};
  
  for (const [fieldName, config] of Object.entries(FIELD_MAPPING)) {
    const measure = measures.find(m => m.type === config.withingsType);
    if (measure?.value != null) {
      extracted[fieldName] = Number(measure.value.toFixed(config.decimals));
    }
  }
  
  return extracted;
}

// Recupera i campi già inviati per questo gruppo
async function getAlreadySentFields(userid, grpid, env) {
  const sentKey = `sent_${userid}_${grpid}`;
  const already = await env.MY_KV.get(sentKey);
  
  if (!already) return {};
  
  try {
    const parsed = JSON.parse(already);
    return parsed.fields || {}; // nuova struttura
  } catch {
    return {}; // se è una vecchia struttura, considera niente come già inviato
  }
}

// Determina quali campi sono nuovi da inviare
function getNewFieldsToSend(extractedData, alreadySent) {
  const newFields = {};
  
  for (const [fieldName, value] of Object.entries(extractedData)) {
    // Invia se non è mai stato inviato o se il valore è diverso
    if (!(fieldName in alreadySent) || alreadySent[fieldName] !== value) {
      newFields[fieldName] = value;
    }
  }
  
  return newFields;
}

// Salva i campi inviati con successo
async function saveSuccessfulFields(userid, grpid, newFields, status, env) {
  const sentKey = `sent_${userid}_${grpid}`;
  
  // Recupera campi già salvati
  const existing = await getAlreadySentFields(userid, grpid, env);
  
  // Merge con nuovi campi
  const allFields = { ...existing, ...newFields };
  
  await env.MY_KV.put(sentKey, JSON.stringify({
    lastSentAt: new Date().toISOString(),
    status: status,
    fields: allFields
  }));
}

// Converti i campi estratti in formato Intervals
function buildIntervalsPayload(extractedData) {
  const payload = {};
  
  for (const [fieldName, value] of Object.entries(extractedData)) {
    const config = FIELD_MAPPING[fieldName];
    if (config) {
      payload[config.intervalsField] = value;
    }
  }
  
  return payload;
}

// Invia i dati wellness a Intervals (PUT /athlete/{id}/wellness/{YYYY-MM-DD})
async function sendToIntervals({ date_iso, wellnessData }, env) {
  const date = date_iso.slice(0,10); // YYYY-MM-DD
  const athleteId = env.INTERVALS_ATHLETE_ID;
  const apiKey = env.INTERVALS_API_KEY;

  const url = `https://intervals.icu/api/v1/athlete/${athleteId}/wellness/${date}`;
  
  // Converti in formato Intervals
  const intervalsPayload = buildIntervalsPayload(wellnessData);

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
