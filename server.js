require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { getVrijeSlots, boekAfspraak, slotsAlsTekst, parseGekozenSlot } = require('./calendar');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api/', rateLimit({ windowMs: 3600000, max: 200 }));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const gesprekken = new Map();
const audioCache = new Map();

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'AI Beller + Calendar actief', versie: '2.0.0' }));

// ── VRIJE SLOTS OPHALEN (voor frontend kalenderweergave) ──────────────────────
app.get('/api/slots', async (req, res) => {
  try {
    const slots = await getVrijeSlots(7, 60);
    res.json({ slots: slots.map(s => ({ label: s.label, start: s.start, eind: s.eind })) });
  } catch (err) {
    res.status(500).json({ error: 'Kon agenda niet ophalen: ' + err.message });
  }
});

// ── GESPREK STARTEN ───────────────────────────────────────────────────────────
app.post('/api/start-call', async (req, res) => {
  const { naam, telefoon, stad, email } = req.body;
  if (!naam || !telefoon) return res.status(400).json({ error: 'naam en telefoon verplicht' });

  try {
    let tel = telefoon.replace(/[\s\-]/g, '');
    if (tel.startsWith('0')) tel = '+31' + tel.slice(1);

    // Haal vrije slots op VOORDAT het gesprek begint
    let vrijeSlots = [];
    try {
      vrijeSlots = await getVrijeSlots(5, 60);
    } catch (e) {
      console.warn('Kon agenda niet ophalen:', e.message);
    }

    const gesprekId = 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    gesprekken.set(gesprekId, {
      naam, telefoon: tel, stad: stad || '', email: email || '',
      history: [], gestart: new Date().toISOString(),
      status: 'bellend', vrijeSlots,
    });

    const call = await twilioClient.calls.create({
      to: tel,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: process.env.SERVER_URL + '/twilio/answer/' + gesprekId,
      statusCallback: process.env.SERVER_URL + '/twilio/status/' + gesprekId,
      statusCallbackEvent: ['completed', 'failed', 'busy', 'no-answer'],
      machineDetection: 'DetectMessageEnd',
      timeout: 30,
    });

    gesprekken.get(gesprekId).twilioSid = call.sid;
    res.json({ success: true, gesprekId, twilioSid: call.sid, aantalVrijeSlots: vrijeSlots.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TWILIO ANSWER ─────────────────────────────────────────────────────────────
app.post('/twilio/answer/:gesprekId', async (req, res) => {
  const gesprek = gesprekken.get(req.params.gesprekId);
  const twiml = new twilio.twiml.VoiceResponse();

  if (req.body.AnsweredBy === 'machine_start' || req.body.AnsweredBy === 'machine_end_beep') {
    twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' },
      'Goedemiddag, u spreekt met Eva van ' + (process.env.BEDRIJF_NAAM || 'Vaste Lasten Deals') +
      '. Wij belden u over uw energiecontract. Bel ons gerust terug. Een fijne dag!');
    if (gesprek) { gesprek.status = 'voicemail'; gesprek.resultaat = 'voicemail'; }
    return res.type('text/xml').send(twiml.toString());
  }

  if (!gesprek) {
    twiml.say({ language: 'nl-NL' }, 'Excuses voor het ongemak.');
    return res.type('text/xml').send(twiml.toString());
  }

  try {
    const opening = await genereerAntwoord(gesprek, null);
    gesprek.history.push({ role: 'assistant', content: opening });
    gesprek.status = 'in_gesprek';
    await spreekEnLuister(twiml, opening, req.params.gesprekId);
    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('Answer fout:', err.message);
    twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' },
      'Goedemiddag, Eva van ' + (process.env.BEDRIJF_NAAM || 'Vaste Lasten Deals') + '. Excuses, wij bellen later terug.');
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  }
});

// ── TWILIO GATHER (klant heeft gesproken) ─────────────────────────────────────
app.post('/twilio/gather/:gesprekId', async (req, res) => {
  const { gesprekId } = req.params;
  const gesprek = gesprekken.get(gesprekId);
  const twiml = new twilio.twiml.VoiceResponse();

  if (!gesprek) { twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }

  const klantTekst = (req.body.SpeechResult || '').trim();
  console.log('[' + gesprekId + '] Klant: "' + klantTekst + '"');
  if (klantTekst) gesprek.history.push({ role: 'user', content: klantTekst });

  // ── Opt-out ────────────────────────────────────────────────────────────────
  const optOut = ['verwijder', 'afmelden', 'bel niet meer', 'nooit meer', 'stop', 'doe dat niet'];
  if (optOut.some(w => klantTekst.toLowerCase().includes(w))) {
    const tekst = 'Ik begrijp het volledig. Uw nummer wordt direct verwijderd. Excuses voor het ongemak en een fijne dag!';
    gesprek.status = 'afgerond'; gesprek.resultaat = 'opt_out';
    await spreekEnSluitAf(twiml, tekst);
    return res.type('text/xml').send(twiml.toString());
  }

  // ── Klant is akkoord → afspraak inboeken ──────────────────────────────────
  const akkoordWoorden = ['akkoord', 'ja graag', 'prima', 'goed', 'oké', 'oke', 'doen we', 'lijkt me goed', 'afgesproken'];
  const isAkkoord = akkoordWoorden.some(w => klantTekst.toLowerCase().includes(w));

  // Als akkoord én we zijn al in de slot-selectie fase
  if (isAkkoord && gesprek.wachtOpSlotKeuze && gesprek.vrijeSlots?.length) {
    const gekozenSlot = parseGekozenSlot(klantTekst, gesprek.vrijeSlots);

    if (gekozenSlot) {
      try {
        // Boek de afspraak in Google Calendar
        const event = await boekAfspraak({
          naam: gesprek.naam,
          telefoon: gesprek.telefoon,
          email: gesprek.email || '',
          startTijd: gekozenSlot.start,
          eindTijd: gekozenSlot.eind,
          notities: 'Ingeboekt via AI Beller Eva. Gesprekken: ' + gesprek.history.length,
        });

        gesprek.status = 'afgerond';
        gesprek.resultaat = 'afspraak';
        gesprek.afspraak = { slot: gekozenSlot.label, eventId: event.id };

        const bevestiging = 'Uitstekend! Ik heb de afspraak voor u ingepland op ' + gekozenSlot.label +
          '. U ontvangt een bevestiging per e-mail. Wij kijken ernaar uit u te spreken. Nog een fijne dag!';
        gesprek.history.push({ role: 'assistant', content: bevestiging });
        await spreekEnSluitAf(twiml, bevestiging);
        return res.type('text/xml').send(twiml.toString());
      } catch (err) {
        console.error('Agenda boeken mislukt:', err.message);
        // Ga door met het gesprek, maar log de fout
      }
    }
  }

  // ── Klant wil een afspraak, geef slots ────────────────────────────────────
  const afspraakWoorden = ['afspraak', 'maak', 'plannen', 'inplannen', 'wanneer', 'welke dag', 'beschikbaar'];
  const wiltAfspraak = afspraakWoorden.some(w => klantTekst.toLowerCase().includes(w)) ||
    (isAkkoord && gesprek.history.length >= 4);

  if (wiltAfspraak && !gesprek.wachtOpSlotKeuze) {
    gesprek.wachtOpSlotKeuze = true;

    // Haal slots op (of gebruik eerder opgehaalde)
    if (!gesprek.vrijeSlots?.length) {
      try { gesprek.vrijeSlots = await getVrijeSlots(5, 60); } catch (e) { gesprek.vrijeSlots = []; }
    }

    const slotTekst = slotsAlsTekst(gesprek.vrijeSlots);
    const antwoord = 'Graag! ' + slotTekst + ' Welke tijd schikt u het beste?';
    gesprek.history.push({ role: 'assistant', content: antwoord });
    await spreekEnLuister(twiml, antwoord, gesprekId);
    return res.type('text/xml').send(twiml.toString());
  }

  // ── Normaal gesprek via Claude ─────────────────────────────────────────────
  const maxBereikt = gesprek.history.length >= 20;
  try {
    const antwoord = await genereerAntwoord(gesprek, klantTekst);
    gesprek.history.push({ role: 'assistant', content: antwoord });

    if (maxBereikt) {
      gesprek.status = 'afgerond'; gesprek.resultaat = 'geen_interesse';
      await spreekEnSluitAf(twiml, antwoord);
    } else {
      await spreekEnLuister(twiml, antwoord, gesprekId);
    }
    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('Gather fout:', err.message);
    twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, 'Excuses, wij bellen u later terug.');
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  }
});

// ── STATUS CALLBACKS ──────────────────────────────────────────────────────────
app.post('/twilio/status/:gesprekId', (req, res) => {
  const gesprek = gesprekken.get(req.params.gesprekId);
  if (gesprek) {
    gesprek.eindStatus = req.body.CallStatus;
    gesprek.duur = req.body.CallDuration;
    gesprek.geëindigd = new Date().toISOString();
    if (!gesprek.resultaat) {
      const map = { busy: 'bezet', 'no-answer': 'niet_opgenomen', failed: 'mislukt', completed: 'afgerond' };
      gesprek.resultaat = map[req.body.CallStatus] || req.body.CallStatus;
    }
  }
  res.sendStatus(200);
});

// ── API ENDPOINTS VOOR FRONTEND ───────────────────────────────────────────────
app.get('/api/gesprekken', (req, res) => {
  res.json(Array.from(gesprekken.entries()).map(([id, g]) => ({
    id, naam: g.naam, telefoon: g.telefoon, stad: g.stad,
    status: g.status, resultaat: g.resultaat,
    afspraak: g.afspraak || null,
    gestart: g.gestart, duur: g.duur,
  })).reverse());
});

app.get('/api/gesprek/:id', (req, res) => {
  const g = gesprekken.get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Niet gevonden' });
  res.json(g);
});

app.post('/api/stop-call/:id', async (req, res) => {
  const g = gesprekken.get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Niet gevonden' });
  try {
    if (g.twilioSid) await twilioClient.calls(g.twilioSid).update({ status: 'completed' });
    g.status = 'gestopt';
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bulk-start', async (req, res) => {
  const { leads, vertraging_seconden = 90 } = req.body;
  if (!leads?.length) return res.status(400).json({ error: 'leads array verplicht' });

  // Haal slots EENMALIG op voor alle gesprekken
  let vrijeSlots = [];
  try { vrijeSlots = await getVrijeSlots(7, 60); } catch (e) { console.warn('Agenda:', e.message); }

  res.json({ bericht: leads.length + ' gesprekken ingepland', vrijeSlots: vrijeSlots.length, vertraging_seconden });

  for (let i = 0; i < leads.length; i++) {
    await new Promise(r => setTimeout(r, i * vertraging_seconden * 1000));
    try {
      let tel = leads[i].telefoon.replace(/[\s\-]/g, '');
      if (tel.startsWith('0')) tel = '+31' + tel.slice(1);
      const id = 'g_' + Date.now() + '_' + i;
      gesprekken.set(id, {
        naam: leads[i].naam, telefoon: tel, stad: leads[i].stad || '',
        email: leads[i].email || '', history: [],
        gestart: new Date().toISOString(), status: 'bellend', vrijeSlots,
      });
      const call = await twilioClient.calls.create({
        to: tel, from: process.env.TWILIO_PHONE_NUMBER,
        url: process.env.SERVER_URL + '/twilio/answer/' + id,
        statusCallback: process.env.SERVER_URL + '/twilio/status/' + id,
        statusCallbackEvent: ['completed', 'failed', 'busy', 'no-answer'],
        machineDetection: 'DetectMessageEnd', timeout: 30,
      });
      gesprekken.get(id).twilioSid = call.sid;
      console.log('Bulk ' + (i + 1) + '/' + leads.length + ': ' + leads[i].naam);
    } catch (err) { console.error('Bulk fout ' + i + ':', err.message); }
  }
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function genereerAntwoord(gesprek, klantTekst) {
  const slotInfo = gesprek.vrijeSlots?.length
    ? 'Beschikbare afspraakmomenten: ' + gesprek.vrijeSlots.slice(0, 3).map(s => s.label).join(', ') + '.'
    : 'De agenda is de komende dagen helaas volledig volgeboekt.';

  const sys = [
    'Je bent Eva, een vriendelijke AI telefoonagent voor ' + (process.env.BEDRIJF_NAAM || 'Vaste Lasten Deals') + '.',
    'Je belt ' + gesprek.naam + (gesprek.stad ? ' in ' + gesprek.stad : '') + ' om een afspraak in te plannen voor een energiegesprek.',
    'Spreek vloeiend Nederlands. Max 2-3 zinnen per beurt. Noem NIET dat je een AI bent tenzij gevraagd.',
    slotInfo,
    'Als de klant wil afspreken, noem dan de beschikbare tijden en vraag welke past.',
    'Wacht tot de klant een dag/tijd kiest voordat je de afspraak bevestigt.',
  ].join(' ');

  const messages = gesprek.history.length === 0
    ? [{ role: 'user', content: 'Begin het gesprek. Stel jezelf voor als Eva van ' + (process.env.BEDRIJF_NAAM || 'Vaste Lasten Deals') + ' en leg het doel uit.' }]
    : gesprek.history.map(h => ({ role: h.role, content: h.content }));

  const resp = await axios.post('https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-20250514', max_tokens: 200, system: sys, messages },
    { headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } }
  );
  return resp.data.content[0].text;
}

async function spreekEnLuister(twiml, tekst, gesprekId) {
  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) {
    try { twiml.play(await genAudio(tekst, gesprekId)); }
    catch { twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, tekst); }
  } else {
    twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, tekst);
  }
  const gather = twiml.gather({
    input: 'speech', language: 'nl-NL', speechTimeout: 'auto',
    speechModel: 'googlev2_telephony', enhanced: true, timeout: 8,
    action: process.env.SERVER_URL + '/twilio/gather/' + gesprekId,
  });
  gather.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, 'Bent u er nog?');
}

async function spreekEnSluitAf(twiml, tekst) {
  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) {
    try { twiml.play(await genAudio(tekst, 'af_' + Date.now())); }
    catch { twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, tekst); }
  } else {
    twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, tekst);
  }
  twiml.hangup();
}

async function genAudio(tekst, id) {
  const resp = await axios.post(
    'https://api.elevenlabs.io/v1/text-to-speech/' + process.env.ELEVENLABS_VOICE_ID,
    { text: tekst, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
    { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' }, responseType: 'arraybuffer' }
  );
  audioCache.set(id, { data: resp.data, ts: Date.now() });
  setTimeout(() => audioCache.delete(id), 300000);
  return process.env.SERVER_URL + '/audio/' + id;
}

app.get('/audio/:id', (req, res) => {
  const item = audioCache.get(req.params.id);
  if (!item) return res.status(404).send('Niet gevonden');
  res.setHeader('Content-Type', 'audio/mpeg');
  res.send(Buffer.from(item.data));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('AI Beller + Calendar draait op poort ' + PORT));
