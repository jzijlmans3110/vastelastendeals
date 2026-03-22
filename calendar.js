const { google } = require('googleapis');

// ── GOOGLE CALENDAR SETUP ─────────────────────────────────────────────────────
// Authenticatie via Service Account (aanbevolen voor servers)
function getCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

// ── VRIJE SLOTS OPHALEN ───────────────────────────────────────────────────────
// Geeft de eerstvolgende N vrije slots terug (werkdagen, 09:00-17:00)
async function getVrijeSlots(aantalDagen = 5, slotDuurMinuten = 60) {
  const calendar = getCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

  const nu = new Date();
  const eindDatum = new Date();
  eindDatum.setDate(nu.getDate() + aantalDagen);

  // Haal alle bestaande afspraken op
  const res = await calendar.events.list({
    calendarId,
    timeMin: nu.toISOString(),
    timeMax: eindDatum.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  const bestaandeAfspraken = (res.data.items || []).map(e => ({
    start: new Date(e.start.dateTime || e.start.date),
    eind: new Date(e.end.dateTime || e.end.date),
  }));

  // Genereer mogelijke slots (werkdagen, 09:00-17:00, elk uur)
  const vrijeSlots = [];
  const cursor = new Date(nu);
  cursor.setMinutes(0, 0, 0);
  cursor.setHours(cursor.getHours() + 1); // Start volgende hele uur

  while (cursor < eindDatum && vrijeSlots.length < 6) {
    const dag = cursor.getDay();
    const uur = cursor.getHours();

    // Alleen werkdagen (ma-vr), 09:00-17:00
    if (dag >= 1 && dag <= 5 && uur >= 9 && uur < 17) {
      const slotEind = new Date(cursor.getTime() + slotDuurMinuten * 60000);

      // Check of slot vrij is
      const isBezet = bestaandeAfspraken.some(a =>
        cursor < a.eind && slotEind > a.start
      );

      if (!isBezet) {
        vrijeSlots.push({
          start: new Date(cursor),
          eind: slotEind,
          label: formatSlot(cursor),
        });
      }
    }

    cursor.setHours(cursor.getHours() + 1);
  }

  return vrijeSlots;
}

// ── AFSPRAAK INBOEKEN ─────────────────────────────────────────────────────────
async function boekAfspraak({ naam, telefoon, email, startTijd, eindTijd, adviseur, contractType, notities }) {
  const calendar = getCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

  const event = {
    summary: `Energiegesprek — ${naam}`,
    description: [
      `Klant: ${naam}`,
      `Telefoon: ${telefoon}`,
      email ? `E-mail: ${email}` : '',
      contractType ? `Contract interesse: ${contractType}` : '',
      adviseur ? `Adviseur: ${adviseur}` : '',
      notities ? `\nNotities: ${notities}` : '',
    ].filter(Boolean).join('\n'),
    start: { dateTime: startTijd.toISOString(), timeZone: 'Europe/Amsterdam' },
    end: { dateTime: eindTijd.toISOString(), timeZone: 'Europe/Amsterdam' },
    attendees: email ? [{ email }] : [],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 60 },
        { method: 'popup', minutes: 15 },
      ],
    },
    colorId: '2', // Groen in Google Calendar
  };

  const result = await calendar.events.insert({ calendarId, resource: event, sendUpdates: 'all' });
  return result.data;
}

// ── AFSPRAAK ANNULEREN ────────────────────────────────────────────────────────
async function annuleerAfspraak(eventId) {
  const calendar = getCalendarClient();
  await calendar.events.delete({
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
    eventId,
    sendUpdates: 'all',
  });
}

// ── HELPER: SLOT LABEL OPMAKEN ────────────────────────────────────────────────
function formatSlot(datum) {
  const dagen = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
  const dag = dagen[datum.getDay()];
  const datumStr = datum.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' });
  const tijdStr = datum.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  return `${dag} ${datumStr} om ${tijdStr}`;
}

// ── SLOTS ALS TEKST VOOR EVA ──────────────────────────────────────────────────
// Geeft een natuurlijke zin terug die Eva kan uitspreken
function slotsAlsTekst(slots) {
  if (!slots.length) return 'Helaas is de agenda de komende dagen volledig volgeboekt.';
  if (slots.length === 1) return `De eerstvolgende beschikbare tijd is ${slots[0].label}.`;
  const eerste = slots.slice(0, 3).map(s => s.label);
  return `Wij hebben nog ruimte op: ${eerste.slice(0, -1).join(', ')} en ${eerste[eerste.length - 1]}. Welke tijd past u het beste?`;
}

// ── PARSE GEKOZEN SLOT UIT KLANTANTWOORD ─────────────────────────────────────
// Matcht een slot op basis van wat de klant zei ("maandag" → eerste maandag slot)
function parseGekozenSlot(klantTekst, beschikbareSlots) {
  const tekst = klantTekst.toLowerCase();
  const dagNamen = { maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5 };

  for (const [naam, nummer] of Object.entries(dagNamen)) {
    if (tekst.includes(naam)) {
      const match = beschikbareSlots.find(s => s.start.getDay() === nummer);
      if (match) return match;
    }
  }

  // Probeer tijdstip te herkennen ("tien uur", "half twee", "14:00")
  const tijdPatterns = [
    { regex: /(\d{1,2})[\s:]?(\d{2})/, parse: m => ({ uur: parseInt(m[1]), min: parseInt(m[2]) }) },
    { regex: /(\d{1,2}) uur/, parse: m => ({ uur: parseInt(m[1]), min: 0 }) },
    { regex: /half (\d{1,2})/, parse: m => ({ uur: parseInt(m[1]) - 1, min: 30 }) },
  ];

  for (const { regex, parse } of tijdPatterns) {
    const match = tekst.match(regex);
    if (match) {
      const { uur, min } = parse(match);
      const slot = beschikbareSlots.find(s => s.start.getHours() === uur && s.start.getMinutes() === min);
      if (slot) return slot;
    }
  }

  // Eerste beschikbare als fallback
  return beschikbareSlots[0] || null;
}

module.exports = { getVrijeSlots, boekAfspraak, annuleerAfspraak, slotsAlsTekst, parseGekozenSlot, formatSlot };
