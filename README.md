# Withings → Cloudflare Worker → Intervals

Questo progetto implementa un **Cloudflare Worker** che riceve notifiche da Withings, estrae le misure rilevanti e le invia automaticamente al servizio **Intervals.icu**.  
Il Worker è progettato per essere modulare, scalabile e robusto, con gestione token OAuth, validazione payload, retry automatici e supporto per retry manuale.

---

## 📌 Funzionalità principali

- Ricezione notifiche **POST** da Withings (`notify`) e gestione subscription (`subscribe`).
- Validazione completa dei payload: `userid`, `startdate`, `enddate`.
- Ottenimento di **access token** valido da KV o refresh automatico.
- Chiamata API Withings `measure?action=getmeas` per ottenere misure.
- Estrazione dei campi configurati (peso, massa muscolare, grasso corporeo, ecc.).
- Invio dati a **Intervals.icu** con retry automatico (2 tentativi).
- Salvataggio KV per retry manuale in caso di fallimento.
- Logging dettagliato di tutte le operazioni.

---

## ⚡ Installazione

1. **Creare il Worker** su Cloudflare Workers.
2. Configurare le **variabili d’ambiente**:
   - `WITHINGS_CLIENT_ID`
   - `WITHINGS_CLIENT_SECRET`
   - `INTERVALS_ATHLETE_ID`
   - `INTERVALS_API_KEY`
   - `MY_KV` → KV namespace per token, dati inviati e retry.
3. Deploy del Worker tramite **Wrangler** o UI Cloudflare.

---

## 📝 Struttura del progetto

- `index.js` → codice principale del Worker
  - `fetch` → entry point HTTP
  - `handleNotify(payload, env)` → processing async delle notifiche
  - `getValidAccessToken(userid, env)` → recupero token con caching
  - `refreshAccessToken(userid, env)` → refresh token con retry automatico
  - Funzioni di supporto:
    - `extractConfiguredFields`
    - `sendToIntervals`
    - `getAlreadySentFields`
    - `saveSuccessfulFields`
    - `getNewFieldsToSend`
    - `buildIntervalsPayload`
- `FIELD_MAPPING` → mapping tra campi Withings e Intervals.

---

## 🔧 Validazione Payload

Ogni payload `notify` viene validato:

- **userid**: obbligatorio, numerico.
- **startdate**: opzionale, default `"0"`, numerico.
- **enddate**: opzionale, default timestamp corrente, numerico.
- Se il payload non è valido, il Worker risponde con **400** e logga l’errore.

> Commenti dettagliati all’interno del codice spiegano il perché di ogni controllo.

---

## 🔄 Gestione Token

- Token memorizzati in KV per ciascun `userid`.
- Se token scaduto o mancante, viene effettuato **refresh automatico** tramite refresh token.
- Retry automatico fino a **3 tentativi** su errore 601 (Too Fast).

---

## ✅ Invio dati a Intervals

- Vengono inviati solo i campi configurati e **nuovi** o modificati rispetto all’ultimo invio.
- Retry automatico **2 volte** se fallisce l’invio.
- Se falliscono tutti i retry, i dati vengono salvati in KV per retry manuale futuro.

---

## 📦 KV Storage

Chiavi principali:

| Chiave                  | Contenuto                                             |
|--------------------------|------------------------------------------------------|
| `token_data_${userid}`   | Dati token con `access_token`, `refresh_token`, `expires_at` |
| `refresh_${userid}`      | Refresh token                                        |
| `sent_${userid}_${grpid}`| Campi già inviati per un gruppo di misure           |
| `retry_${userid}_${grpid}` | Dati da inviare manualmente se retry fallito       |

---

## ⚠️ Error Handling

- Tutti gli errori vengono loggati su console.
- I flussi principali non vengono bloccati dagli errori: il Worker risponde subito a Withings.
- Retry automatici gestiti per token e invio Intervals.
- Dati persistenti salvati per retry manuale se necessario.

---

## 🌐 Flusso generale

1. Richiesta HTTP → HEAD o POST
2. `subscribe` → risposta immediata `{status:0}`
3. `notify` → validazione payload
4. Risposta immediata `"OK"` + `ctx.waitUntil(handleNotify)`
5. Recupero access token valido (cache KV o refresh)
6. Chiamata API Withings `getmeas`
7. Processa groups e misura campi configurati
8. Controlla già inviati → invia nuovi campi a Intervals
9. Retry automatico su invio fallito → salvataggio KV per retry manuale
10. Logging completo ad ogni step

---

## 🛠️ Suggerimenti

- Aggiornare `FIELD_MAPPING` per aggiungere nuovi campi Withings.
- Monitorare i log del Worker per eventuali errori o retry.
- Pulizia periodica KV consigliata per evitare accumulo dati vecchi.

---

## 📄 Licenza

Progetto open-source. Modifica e riutilizzo consentiti.

