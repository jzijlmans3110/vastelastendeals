# Setup Handleiding v2.0 — AI Beller + Google Calendar

## Overzicht

Eva belt automatisch leads op, checkt live de Google Agenda, biedt beschikbare tijdslots aan en boekt de afspraak direct in — zonder dat een mens iets hoeft te doen.

---

## Stap 1 — Google Calendar koppelen (Service Account)

Dit is de enige technische stap. Daarna werkt alles automatisch.

### 1a. Google Cloud Project aanmaken
1. Ga naar **console.cloud.google.com**
2. Klik bovenaan op het project dropdown → "Nieuw project"
3. Naam: "AI Beller" → Maken

### 1b. Google Calendar API aanzetten
1. Ga naar "APIs en services" → "Bibliotheek"
2. Zoek "Google Calendar API" → klik "Inschakelen"

### 1c. Service Account aanmaken
1. Ga naar "APIs en services" → "Inloggegevens"
2. Klik "+ Inloggegevens maken" → "Serviceaccount"
3. Naam: "ai-beller" → Maken en doorgaan → Gereed
4. Klik op het nieuwe serviceaccount in de lijst
5. Ga naar tabblad "Sleutels" → "Sleutel toevoegen" → "Nieuwe sleutel maken" → JSON
6. Het JSON-bestand wordt gedownload — bewaar dit veilig!

Uit het JSON-bestand heb je nodig:
- `client_email` → dit is je `GOOGLE_CLIENT_EMAIL`
- `private_key` → dit is je `GOOGLE_PRIVATE_KEY`

### 1d. Agenda delen met het Service Account
1. Open **Google Calendar** (calendar.google.com)
2. Klik op de drie puntjes naast je teamagenda → "Instellingen en delen"
3. Scroll naar "Delen met specifieke personen"
4. Voeg het `client_email` toe (bijv. ai-beller@jouw-project.iam.gserviceaccount.com)
5. Stel in op **"Wijzigingen aanbrengen in evenementen"** (Bewerker)
6. Opslaan

Je `GOOGLE_CALENDAR_ID` is het e-mailadres van de agenda (zichtbaar bij Agenda-instellingen → Agenda-ID).

---

## Stap 2 — Twilio Telefoonnummer

1. Ga naar **console.twilio.com**
2. Phone Numbers → Manage → Buy a Number
3. Filter op "NL" (Nederland) en kies een nummer
4. Kopieer:
   - Account SID (bovenaan dashboard)
   - Auth Token (bovenaan dashboard)
   - Je nieuwe telefoonnummer

---

## Stap 3 — Railway deployen

1. Maak een GitHub repository: **github.com → New → "ai-beller-backend"**
2. Upload alle bestanden: `server.js`, `calendar.js`, `package.json`, `railway.json`
3. Ga naar **railway.app** → "New Project" → "Deploy from GitHub"
4. Selecteer je repo → Railway deployt automatisch

### Environment Variables instellen in Railway:
Ga naar je project → Settings → Variables → voeg toe:

```
TWILIO_ACCOUNT_SID       = ACxxx...
TWILIO_AUTH_TOKEN        = xxx...
TWILIO_PHONE_NUMBER      = +31xxxxxxxxx
ANTHROPIC_API_KEY        = sk-ant-api03-...
ELEVENLABS_API_KEY       = sk_...             (optioneel)
ELEVENLABS_VOICE_ID      = SXBL9NbvTrjs...   (optioneel)
GOOGLE_CLIENT_EMAIL      = ai-beller@jouw-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY       = -----BEGIN PRIVATE KEY-----\nxxx...\n-----END PRIVATE KEY-----\n
GOOGLE_CALENDAR_ID       = agenda@julliebedrijf.nl
SERVER_URL               = https://ai-beller-xxx.railway.app
FRONTEND_URL             = https://jullie-app.lovable.app
BEDRIJF_NAAM             = Vaste Lasten Deals
```

⚠️ Let op bij GOOGLE_PRIVATE_KEY: plak de volledige key inclusief de `-----BEGIN/END PRIVATE KEY-----` regels. Vervang echte newlines door `\n`.

---

## Stap 4 — Lovable koppelen

1. Open je Lovable app → Instellingen
2. Vul in bij "Backend URL": je Railway URL (bijv. `https://ai-beller-xxx.railway.app`)
3. Opslaan

De Lovable app kan nu:
- `/api/slots` aanroepen om vrije agenda-slots te tonen
- `/api/start-call` aanroepen om één gesprek te starten
- `/api/bulk-start` aanroepen om de hele leadlijst te bellen
- `/api/gesprekken` pollen voor live statusupdates

---

## Stap 5 — Testen

1. Zet je eigen nummer in de bellijst als eerste lead
2. Klik "Starten" in Lovable
3. Je telefoon gaat over
4. Eva stelt zich voor, noemt beschikbare tijdslots
5. Zeg "Maandag is prima" → Eva bevestigt en sluit het gesprek
6. Check je Google Calendar — de afspraak staat er in!

---

## Hoe Eva omgaat met de agenda

| Situatie | Wat Eva doet |
|---|---|
| Klant wil afspreken | Noemt de 3 eerstvolgende vrije slots |
| Agenda is vol | Zegt dat de agenda vol is en vraagt terugbelnummer |
| Klant kiest een dag | Boekt direct in Calendar, stuurt bevestiging |
| Klant zegt opt-out | Verwijdert uit lijst, beëindigt gesprek |
| Voicemail | Laat bericht achter, markeert als "voicemail" |

---

## Kosten schatting

| Service | Kosten |
|---|---|
| Railway hosting | Gratis tot $5/maand |
| Twilio NL bellen | ~€0,05/minuut uitgaand |
| Anthropic Claude | ~€0,003 per AI-beurt |
| ElevenLabs stem | $5-22/maand (optioneel) |
| Google Calendar API | Gratis |
| **100 gesprekken × 3 min** | **~€15-25/maand totaal** |

---

## Wettelijke vereisten Nederland

- Bel alleen tussen **09:00 en 20:00** (weekdagen)
- Eva identificeert zich als beller van het bedrijf
- Opt-out is ingebouwd ("verwijder mijn nummer" werkt altijd)
- Gebruik alleen **GDPR-conforme** leadlijsten (toestemming)
- Bij meer dan 5.000 calls/dag: registratie bij ACM vereist
