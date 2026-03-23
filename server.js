require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { getVrijeSlots, boekAfspraak, slotsAlsTekst, parseGekozenSlot } = require('./calendar');

const app = express();

app.use(cors({
  origin: [
    'https://vastelastendeals.lovable.app',
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/', rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 300
}));

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const gesprekken = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function normalizePhone(input) {
  if (!input) return '';
  let tel = String(input).trim().replace(/[\s\-().]/g, '');

  if (tel.startsWith('00')) tel = '+' + tel.slice(2);
  if (tel.startsWith('0')) tel = '+31' + tel.slice(1);
  if (!tel.startsWith('+')) tel = '+' + tel;

  return tel;
}

function gesprekOverzicht(id, g) {
  return {
    id,
    naam: g.naam,
    telefoon: g.telefoon,
    stad: g.stad,
    email: g.email,
    status: g.status,
    resultaat: g.resultaat || null,
    afspraak: g.afspraak || null,
    gestart: g.gestart,
    geëindigd: g.geëindigd || null,
    duur: g.duur || null,
    twilioSid: g.twilioSid || null,
    historyCount: g.history?.length || 0
  };
}

function veiligeTekstVoorTTS(text) {
  if (!text) return '';
  return String(text)
    .replace(/\*/g, '')
    .replace(/#/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

app.get('/', (req, res) => {
  res.json({
    status: 'AI Beller backend actief',
    versie: '4.0.0',
    mode: 'twilio-voice-stable'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    twilioConfigured: !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN && !!process.env.TWILIO_PHONE_NUMBER,
    anthropicConfigured: !!process.env.ANTHROPIC_API_KEY,
    elevenlabsConfigured: !!process.env.ELEVENLABS_API_KEY && !!process.env.ELEVENLABS_VOICE_ID,
    serverUrl: process.env.SERVER_URL || null
  });
});

app.get('/api/slots', async (req, res) => {
  try {
    const dagen = Number(req.query.days || 7);
    const duurMinuten = Number(req.query.duration || 60);

    const slots = await getVrijeSlots(dagen, duurMinuten);

    res.json({
      ok: true,
      count: slots.length,
      slots: slots.map((s) => ({
        label: s.label,
        start: s.start,
        eind: s.eind
      }))
    });
  } catch (err) {
    log('SLOTS FOUT:', err.message);
    res.status(500).json({
      error: 'Kon agenda niet ophalen',
      details: err.message
    });
  }
});

app.post('/api/claude', async (req, res) => {
  try {
    const {
      messages = [],
      system = '',
      model = 'claude-sonnet-4-20250514',
      max_tokens = 300
    } = req.body || {};

    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model, max_tokens, system, messages },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        timeout: 30000
      }
    );

    res.json(resp.data);
  } catch (err) {
    log('CLAUDE PROXY FOUT:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: 'Claude request mislukt',
      details: err.response?.data || err.message
    });
  }
});

app.post('/api/elevenlabs/tts/:voiceId?', async (req, res) => {
  try {
    const voiceId = req.params.voiceId || req.body.voiceId || process.env.ELEVENLABS_VOICE_ID;
    const text = req.body.text || req.body.input || '';

    if (!voiceId) {
      return res.status(400).json({ error: 'Geen voiceId meegegeven' });
    }

    if (!text.trim()) {
      return res.status(400).json({ error: 'Geen text meegegeven' });
    }

    const resp = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text,
        model_id: req.body.model_id || 'eleven_multilingual_v2',
        voice_settings: req.body.voice_settings || {
          stability: 0.5,
          similarity_boost: 0.75
        }
      },
      {
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg'
        },
        responseType: 'arraybuffer',
        timeout: 30000
      }
    );

    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(resp.data));
  } catch (err) {
    log('ELEVENLABS PROXY FOUT:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: 'ElevenLabs TTS mislukt',
      details: err.response?.data || err.message
    });
  }
});

app.get('/api/elevenlabs/tts/test', (req, res) => {
  res.json({
    ok: true,
    hasApiKey: !!process.env.ELEVENLABS_API_KEY,
    hasVoiceId: !!process.env.ELEVENLABS_VOICE_ID,
    voiceId: process.env.ELEVENLABS_VOICE_ID || null
  });
});

app.get('/api/gesprekken', (req, res) => {
  res.json(
    Array.from(gesprekken.entries())
      .map(([id, g]) => gesprekOverzicht(id, g))
      .reverse()
  );
});

app.get('/api/gesprek/:id', (req, res) => {
  const g = gesprekken.get(req.params.id);
  if (!g) {
    return res.status(404).json({ error: 'Niet gevonden' });
  }
  res.json(g);
});

async function startGesprekEnBel({ naam, telefoon, stad, email }) {
  if (!naam || !telefoon) {
    throw new Error('naam en telefoon verplicht');
  }

  const tel = normalizePhone(telefoon);
  if (!tel) {
    throw new Error('ongeldig telefoonnummer');
  }

  let vrijeSlots = [];
  try {
    vrijeSlots = await getVrijeSlots(5, 60);
  } catch (e) {
    log('AGENDA WAARSCHUWING:', e.message);
  }

  const gesprekId = 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

  gesprekken.set(gesprekId, {
    naam,
    telefoon: tel,
    stad: stad || '',
    email: email || '',
    history: [],
    gestart: new Date().toISOString(),
    status: 'bellen_gestart',
    resultaat: null,
    vrijeSlots,
    wachtOpSlotKeuze: false,
    metadata: {}
  });

  log('TWILIO CALL CREATE START', {
    gesprekId,
    to: tel,
    from: process.env.TWILIO_PHONE_NUMBER
  });

  const call = await twilioClient.calls.create({
    to: tel,
    from: process.env.TWILIO_PHONE_NUMBER,
    url: `${process.env.SERVER_URL}/twilio/answer/${gesprekId}`,
    statusCallback: `${process.env.SERVER_URL}/twilio/status/${gesprekId}`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    timeout: 30
  });

  const gesprek = gesprekken.get(gesprekId);
  gesprek.twilioSid = call.sid;
  gesprek.status = 'bellen';

  log('TWILIO CALL CREATED', {
    gesprekId,
    twilioSid: call.sid
  });

  return {
    success: true,
    gesprekId,
    twilioSid: call.sid,
    aantalVrijeSlots: vrijeSlots.length
  };
}

app.post('/api/start-call', async (req, res) => {
  try {
    const result = await startGesprekEnBel({
      naam: req.body.naam,
      telefoon: req.body.telefoon,
      stad: req.body.stad,
      email: req.body.email
    });

    res.json(result);
  } catch (err) {
    log('START-CALL FOUT:', {
      message: err.message,
      code: err.code,
      status: err.status,
      moreInfo: err.moreInfo
    });

    res.status(500).json({
      error: err.message,
      code: err.code || null,
      status: err.status || null,
      moreInfo: err.moreInfo || null
    });
  }
});

app.post('/api/call', async (req, res) => {
  try {
    const naam = req.body.naam || req.body.name || 'Lead';
    const telefoon = req.body.telefoon || req.body.phone || req.body.to;
    const stad = req.body.stad || req.body.city || '';
    const email = req.body.email || '';

    if (!telefoon) {
      return res.status(400).json({ error: 'telefoon / phone / to verplicht' });
    }

    const result = await startGesprekEnBel({
      naam,
      telefoon,
      stad,
      email
    });

    res.json(result);
  } catch (err) {
    log('API CALL FOUT:', {
      message: err.message,
      code: err.code,
      status: err.status,
      moreInfo: err.moreInfo
    });

    res.status(500).json({
      error: err.message,
      code: err.code || null,
      status: err.status || null,
      moreInfo: err.moreInfo || null
    });
  }
});

app.post('/api/bulk-start', async (req, res) => {
  const { leads, vertraging_seconden = 90 } = req.body;

  if (!Array.isArray(leads) || !leads.length) {
    return res.status(400).json({ error: 'leads array verplicht' });
  }

  res.json({
    ok: true,
    bericht: `${leads.length} gesprekken ingepland`,
    vertraging_seconden
  });

  for (let i = 0; i < leads.length; i++) {
    setTimeout(async () => {
      try {
        await startGesprekEnBel({
          naam: leads[i].naam || leads[i].name || 'Lead',
          telefoon: leads[i].telefoon || leads[i].phone || leads[i].to,
          stad: leads[i].stad || leads[i].city || '',
          email: leads[i].email || ''
        });

        log(`BULK CALL ${i + 1}/${leads.length} GESTART`);
      } catch (err) {
        log(`BULK CALL ${i + 1}/${leads.length} FOUT`, err.message);
      }
    }, i * Number(vertraging_seconden) * 1000);
  }
});

app.post('/api/stop-call/:id', async (req, res) => {
  const g = gesprekken.get(req.params.id);

  if (!g) {
    return res.status(404).json({ error: 'Niet gevonden' });
  }

  try {
    if (g.twilioSid) {
      await twilioClient.calls(g.twilioSid).update({ status: 'completed' });
    }

    g.status = 'gestopt';
    g.resultaat = g.resultaat || 'gestopt';

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/twilio/answer/:gesprekId', async (req, res) => {
  const gesprek = gesprekken.get(req.params.gesprekId);
  const twiml = new twilio.twiml.VoiceResponse();

  log('TWILIO ANSWER HIT', req.params.gesprekId, {
    callSid: req.body.CallSid,
    answeredBy: req.body.AnsweredBy
  });

  if (!gesprek) {
    twiml.say(
      { language: 'nl-NL', voice: 'Polly.Lotte' },
      'Excuses, gesprek niet gevonden.'
    );
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  gesprek.status = 'in_gesprek';

  const opening = veiligeTekstVoorTTS(
    `Goedemiddag, spreek ik met ${gesprek.naam}? U spreekt met Eva van ${process.env.BEDRIJF_NAAM || 'Vaste Lasten Deals'}. Ik bel u kort over een gunstig energieaanbod. Kunt u mij goed verstaan?`
  );

  gesprek.history.push({ role: 'assistant', content: opening });

  twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, opening);

  const gather = twiml.gather({
    input: 'speech',
    language: 'nl-NL',
    speechTimeout: 'auto',
    timeout: 8,
    action: `${process.env.SERVER_URL}/twilio/gather/${req.params.gesprekId}`,
    method: 'POST'
  });

  gather.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, 'Ik luister.');

  return res.type('text/xml').send(twiml.toString());
});

app.post('/twilio/gather/:gesprekId', async (req, res) => {
  const { gesprekId } = req.params;
  const gesprek = gesprekken.get(gesprekId);
  const twiml = new twilio.twiml.VoiceResponse();

  log('TWILIO GATHER HIT', gesprekId, {
    speech: req.body.SpeechResult,
    confidence: req.body.Confidence,
    callSid: req.body.CallSid
  });

  if (!gesprek) {
    twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, 'Gesprek niet gevonden.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const klantTekst = (req.body.SpeechResult || '').trim();

  if (!klantTekst) {
    await spreekEnLuister(
      twiml,
      'Ik heb u niet goed verstaan. Kunt u dat alstublieft herhalen?',
      gesprekId
    );
    return res.type('text/xml').send(twiml.toString());
  }

  gesprek.history.push({ role: 'user', content: klantTekst });

  const klantTekstLower = klantTekst.toLowerCase();

  const optOutWoorden = ['verwijder', 'afmelden', 'bel niet meer', 'nooit meer', 'stop', 'geen interesse'];
  if (optOutWoorden.some((w) => klantTekstLower.includes(w))) {
    gesprek.status = 'afgerond';
    gesprek.resultaat = 'opt_out';

    await spreekEnSluitAf(
      twiml,
      'Begrijpelijk. We zullen uw gegevens niet verder gebruiken. Bedankt en nog een fijne dag.'
    );

    return res.type('text/xml').send(twiml.toString());
  }

  const afspraakIntentWoorden = ['afspraak', 'plannen', 'inplannen', 'ja', 'graag', 'prima', 'goed', 'interesse'];
  const wilAfspraak = afspraakIntentWoorden.some((w) => klantTekstLower.includes(w));

  if (gesprek.wachtOpSlotKeuze && gesprek.vrijeSlots?.length) {
    const gekozenSlot = parseGekozenSlot(klantTekst, gesprek.vrijeSlots);

    if (gekozenSlot) {
      try {
        const event = await boekAfspraak({
          naam: gesprek.naam,
          telefoon: gesprek.telefoon,
          email: gesprek.email || '',
          startTijd: gekozenSlot.start,
          eindTijd: gekozenSlot.eind,
          notities: `Ingeboekt via AI Beller Eva. GesprekId: ${gesprekId}`
        });

        gesprek.status = 'afgerond';
        gesprek.resultaat = 'afspraak';
        gesprek.afspraak = {
          slot: gekozenSlot.label,
          eventId: event.id
        };

        const bevestiging = veiligeTekstVoorTTS(
          `Perfect. Ik heb de afspraak ingepland op ${gekozenSlot.label}. U ontvangt hiervan een bevestiging. Nog een fijne dag.`
        );

        gesprek.history.push({ role: 'assistant', content: bevestiging });
        await spreekEnSluitAf(twiml, bevestiging);
        return res.type('text/xml').send(twiml.toString());
      } catch (err) {
        log('AGENDA BOEKEN MISLUKT:', err.message);

        await spreekEnLuister(
          twiml,
          'Het lukt op dit moment niet om de afspraak direct vast te leggen. Ik kan wel een terugbelverzoek voor u noteren. Heeft u daar interesse in?',
          gesprekId
        );

        return res.type('text/xml').send(twiml.toString());
      }
    }

    await spreekEnLuister(
      twiml,
      'Ik kon het gekozen tijdstip niet goed herkennen. Wilt u een van de genoemde momenten herhalen?',
      gesprekId
    );

    return res.type('text/xml').send(twiml.toString());
  }

  if (wilAfspraak && !gesprek.wachtOpSlotKeuze) {
    gesprek.wachtOpSlotKeuze = true;

    if (!gesprek.vrijeSlots?.length) {
      try {
        gesprek.vrijeSlots = await getVrijeSlots(5, 60);
      } catch (e) {
        gesprek.vrijeSlots = [];
      }
    }

    if (gesprek.vrijeSlots.length) {
      const slotTekst = slotsAlsTekst(gesprek.vrijeSlots);
      const antwoord = veiligeTekstVoorTTS(
        `Graag. ${slotTekst} Welk moment past u het beste?`
      );

      gesprek.history.push({ role: 'assistant', content: antwoord });
      await spreekEnLuister(twiml, antwoord, gesprekId);
      return res.type('text/xml').send(twiml.toString());
    }

    const fallbackAntwoord = veiligeTekstVoorTTS(
      'Prima. Ik zie op dit moment geen vrije momenten in de agenda. Ik kan wel laten terugbellen door een medewerker. Is dat goed?'
    );

    gesprek.history.push({ role: 'assistant', content: fallbackAntwoord });
    await spreekEnLuister(twiml, fallbackAntwoord, gesprekId);
    return res.type('text/xml').send(twiml.toString());
  }

  try {
    const antwoord = veiligeTekstVoorTTS(await genereerAntwoord(gesprek));
    gesprek.history.push({ role: 'assistant', content: antwoord });

    if (gesprek.history.length >= 20) {
      gesprek.status = 'afgerond';
      gesprek.resultaat = gesprek.resultaat || 'afgerond';
      await spreekEnSluitAf(twiml, antwoord);
    } else {
      await spreekEnLuister(twiml, antwoord, gesprekId);
    }

    return res.type('text/xml').send(twiml.toString());
  } catch (err) {
    log('GATHER FOUT:', err.message);

    await spreekEnLuister(
      twiml,
      'Excuses, er ging iets mis aan onze kant. Wilt u aangeven of u interesse heeft in een afspraak?',
      gesprekId
    );

    return res.type('text/xml').send(twiml.toString());
  }
});

app.post('/twilio/status/:gesprekId', (req, res) => {
  const gesprek = gesprekken.get(req.params.gesprekId);

  log('TWILIO STATUS', req.params.gesprekId, {
    status: req.body.CallStatus,
    duration: req.body.CallDuration,
    answeredBy: req.body.AnsweredBy
  });

  if (gesprek) {
    gesprek.eindStatus = req.body.CallStatus;
    gesprek.duur = req.body.CallDuration;
    gesprek.geëindigd = new Date().toISOString();

    if (req.body.CallStatus === 'initiated') gesprek.status = 'geinitieerd';
    if (req.body.CallStatus === 'ringing') gesprek.status = 'gaat_over';
    if (req.body.CallStatus === 'answered') gesprek.status = 'in_gesprek';

    if (!gesprek.resultaat && ['busy', 'no-answer', 'failed', 'completed'].includes(req.body.CallStatus)) {
      const map = {
        busy: 'bezet',
        'no-answer': 'niet_opgenomen',
        failed: 'mislukt',
        completed: 'afgerond'
      };
      gesprek.resultaat = map[req.body.CallStatus] || req.body.CallStatus;
    }
  }

  res.sendStatus(200);
});

async function genereerAntwoord(gesprek) {
  const slotInfo = gesprek.vrijeSlots?.length
    ? 'Beschikbare afspraakmomenten: ' + gesprek.vrijeSlots.slice(0, 3).map((s) => s.label).join(', ') + '.'
    : 'De agenda is op dit moment beperkt beschikbaar.';

  const system = [
    `Je bent Eva, een vriendelijke Nederlandse telefoonagent voor ${process.env.BEDRIJF_NAAM || 'Vaste Lasten Deals'}.`,
    'Je belt prospects kort en duidelijk over een energieaanbod.',
    'Spreek vloeiend Nederlands.',
    'Houd antwoorden natuurlijk en geschikt voor telefoon.',
    'Gebruik maximaal 2 of 3 zinnen per beurt.',
    'Wees commercieel maar niet opdringerig.',
    'Stuur subtiel richting een afspraak als er interesse is.',
    slotInfo
  ].join(' ');

  const messages = gesprek.history.length
    ? gesprek.history.map((h) => ({ role: h.role, content: h.content }))
    : [{ role: 'user', content: 'Begin het gesprek kort en professioneel.' }];

  const resp = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 180,
      system,
      messages
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      timeout: 30000
    }
  );

  return resp.data.content?.[0]?.text || 'Prima, dank u wel voor uw reactie.';
}

async function spreekEnLuister(twiml, tekst, gesprekId) {
  twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, veiligeTekstVoorTTS(tekst));

  const gather = twiml.gather({
    input: 'speech',
    language: 'nl-NL',
    speechTimeout: 'auto',
    timeout: 8,
    action: `${process.env.SERVER_URL}/twilio/gather/${gesprekId}`,
    method: 'POST'
  });

  gather.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, 'Ik luister.');
}

async function spreekEnSluitAf(twiml, tekst) {
  twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, veiligeTekstVoorTTS(tekst));
  twiml.hangup();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`AI Beller backend draait op poort ${PORT}`);
});
