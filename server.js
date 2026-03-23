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
const audioCache = new Map();

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

function veiligeTekstVoorTTS(text) {
  if (!text) return '';
  return String(text)
    .replace(/\*/g, '')
    .replace(/#/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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
    historyCount: g.history?.length || 0,
    kwalificatie: g.kwalificatie || null
  };
}

function updateKwalificatieUitTekst(gesprek, tekst) {
  if (!tekst) return;

  const t = tekst.toLowerCase();
  if (!gesprek.kwalificatie) {
    gesprek.kwalificatie = {
      contract_type: 'onbekend',
      open_to_switch: 'onbekend',
      monthly_amount: null,
      supplier: null,
      appointment_interest: 'onbekend'
    };
  }

  if (t.includes('variabel')) gesprek.kwalificatie.contract_type = 'variabel';
  if (t.includes('vast')) gesprek.kwalificatie.contract_type = 'vast';

  const openSignals = [
    'ja graag',
    'prima',
    'is goed',
    'kan wel',
    'mag wel',
    'interesse',
    'open voor',
    'zou wel willen',
    'zou ik wel willen'
  ];
  if (openSignals.some((s) => t.includes(s))) {
    gesprek.kwalificatie.open_to_switch = 'ja';
    gesprek.kwalificatie.appointment_interest = 'ja';
  }

  const noSignals = [
    'geen interesse',
    'niet nodig',
    'laat maar',
    'hoeft niet',
    'wil niet overstappen',
    'niet overstappen'
  ];
  if (noSignals.some((s) => t.includes(s))) {
    gesprek.kwalificatie.open_to_switch = 'nee';
    gesprek.kwalificatie.appointment_interest = 'nee';
  }

  const suppliers = [
    'vattenfall',
    'essent',
    'engie',
    'budget energie',
    'budgetenergie',
    'eneco',
    'greenchoice',
    'delta',
    'eon',
    'energie direct',
    'energiedirect'
  ];

  for (const supplier of suppliers) {
    if (t.includes(supplier)) {
      gesprek.kwalificatie.supplier = supplier;
      break;
    }
  }

  const euroMatch = t.match(/(\d{2,5})/);
  if (euroMatch && !gesprek.kwalificatie.monthly_amount) {
    const bedrag = euroMatch[1];
    const num = Number(bedrag);
    if (num >= 50 && num <= 50000) {
      gesprek.kwalificatie.monthly_amount = bedrag;
    }
  }
}

async function genAudioViaElevenLabs(tekst, id) {
  const resp = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
    {
      text: veiligeTekstVoorTTS(tekst),
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.28,
        similarity_boost: 0.92,
        style: 0.48,
        use_speaker_boost: true
      }
    },
    {
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer',
      timeout: 30000
    }
  );

  audioCache.set(id, {
    data: resp.data,
    ts: Date.now()
  });

  setTimeout(() => {
    audioCache.delete(id);
  }, 5 * 60 * 1000);

  return `${process.env.SERVER_URL}/audio/${id}`;
}

async function spreekEnLuister(twiml, tekst, gesprekId) {
  const audioId = `${gesprekId}_${Date.now()}`;
  const audioUrl = await genAudioViaElevenLabs(tekst, audioId);

  twiml.play(audioUrl);

  twiml.gather({
    input: 'speech',
    language: 'nl-NL',
    speechTimeout: 'auto',
    timeout: 8,
    action: `${process.env.SERVER_URL}/twilio/gather/${gesprekId}`,
    method: 'POST'
  });
}

async function spreekEnSluitAf(twiml, tekst) {
  const audioId = `af_${Date.now()}`;
  const audioUrl = await genAudioViaElevenLabs(tekst, audioId);
  twiml.play(audioUrl);
  twiml.hangup();
}

async function genereerAntwoord(gesprek) {
  const q = gesprek.kwalificatie || {
    contract_type: 'onbekend',
    open_to_switch: 'onbekend',
    monthly_amount: null,
    supplier: null,
    appointment_interest: 'onbekend'
  };

  const slotInfo = gesprek.vrijeSlots?.length
    ? 'Beschikbare afspraakmomenten zijn: ' + gesprek.vrijeSlots.slice(0, 3).map((s) => s.label).join(', ') + '.'
    : 'Er zijn nu geen directe vrije momenten zichtbaar in de agenda.';

  const system = `
Je bent Eva, een extreem realistische Nederlandse outbound beller voor ${process.env.BEDRIJF_NAAM || 'Vaste Lasten Deals'}.

Je belt ondernemers over hun zakelijke energiecontract.

Je klinkt menselijk. Warm. Rustig. Zelfverzekerd. Natuurlijk.
Niet overdreven vrolijk. Niet te commercieel. Niet callcenter-achtig.

HEEL BELANGRIJK VOOR SPRAAK EN INTONATIE:
- Schrijf zoals iemand echt praat.
- Gebruik korte zinnen.
- Gebruik natuurlijke komma's, punten, kleine onderbrekingen.
- Gebruik af en toe woorden zoals:
  "helemaal goed",
  "snap ik",
  "begrijpelijk",
  "even kijken",
  "duidelijk",
  "ja precies".
- Gebruik geen lange alinea's.
- Gebruik geen stijve of te perfecte taal.
- Gebruik 1 tot 3 zinnen per beurt.
- Stel maximaal 1 hoofdvraag tegelijk.
- Laat zinnen natuurlijk lopen, bijvoorbeeld:
  "Helemaal goed, duidelijk. Mag ik u dan heel kort iets vragen?"
  of
  "Snap ik. En zit u op dit moment nog steeds variabel?"
- Laat gevoelige vragen zachter klinken door ze kleiner te maken:
  "Weet u toevallig ook, een beetje globaal, wat u per maand betaalt?"
- Gebruik geen bullet points in je antwoord.
- Je output moet ALTIJD klinken alsof iemand het uitspreekt aan de telefoon.

DOEL VAN HET GESPREK:
Je doel is niet om direct iets te verkopen.
Je doel is om te kwalificeren, en daarna pas rustig naar een afspraak toe te werken.

JE MOET ACHTERHALEN:
1. Of de ondernemer variabel zit of vast.
2. Of de ondernemer openstaat om over te stappen.
3. Wat het huidige maandbedrag ongeveer is.
4. Bij welke leverancier de ondernemer zit.

BEKENDE INFO TOT NU TOE:
contract_type=${q.contract_type}
open_to_switch=${q.open_to_switch}
monthly_amount=${q.monthly_amount || 'onbekend'}
supplier=${q.supplier || 'onbekend'}
appointment_interest=${q.appointment_interest}

GESPREKSSTRUCTUUR:
- Begin relaxed.
- Niet te veel uitleg ineens.
- Eerst context, dan 1 logische vraag.
- Niet meteen naar geld vragen.
- Eerst kijken of iemand variabel zit.
- Daarna of iemand openstaat voor overstappen.
- Daarna pas leverancier en maandbedrag.
- Pas als de lead geschikt klinkt, stuur je naar een afspraak.

TOON:
- Kalm.
- Echt.
- Licht adviserend.
- Nooit pushy.
- Licht informeel zakelijk.
- Alsof je iemand even tussendoor belt.

ALS IEMAND DRUK IS:
Erken dat eerst.
Voorbeeldtoon:
"Snap ik helemaal. Dan houd ik het ook echt kort."

ALS IEMAND TWIJFELT:
Druk niet door.
Voorbeeldtoon:
"Begrijpelijk hoor. Ik vraag het vooral even, omdat het in sommige gevallen toch interessant kan zijn om ernaar te kijken."

ALS IEMAND OPEN KLINKT:
Vat kort samen en ga rustig richting afspraak.

ALS IEMAND GEEN INTERESSE HEEFT:
Rond netjes af. Kort. Vriendelijk.

AFSPRAAKREGEL:
Plan alleen een afspraak als de ondernemer:
- variabel zit of mogelijk ongunstige voorwaarden heeft,
- en openstaat om te kijken,
- en voldoende interesse toont.

${slotInfo}

EXTRA BELANGRIJK:
Schrijf antwoorden alsof ze direct door ElevenLabs uitgesproken worden.
Dus:
- kort
- ritmisch
- natuurlijk
- spreekbaar
- menselijk

Geef nu het best mogelijke natuurlijke telefonische antwoord op basis van de gesprekshistorie.
`.trim();

  const messages = gesprek.history.length
    ? gesprek.history.map((h) => ({ role: h.role, content: h.content }))
    : [
        {
          role: 'user',
          content: 'Begin het gesprek met een korte, ontspannen, natuurlijke opening voor een ondernemer.'
        }
      ];

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

  return resp.data.content?.[0]?.text || 'Helemaal goed. Mag ik u heel kort iets vragen over uw huidige energiecontract?';
}

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
    metadata: {},
    kwalificatie: {
      contract_type: 'onbekend',
      open_to_switch: 'onbekend',
      monthly_amount: null,
      supplier: null,
      appointment_interest: 'onbekend'
    }
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

app.get('/', (req, res) => {
  res.json({
    status: 'AI Beller backend actief',
    versie: '7.0.0',
    mode: 'natural-energy-outreach'
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
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.28,
          similarity_boost: 0.92,
          style: 0.48,
          use_speaker_boost: true
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

app.get('/audio/:id', (req, res) => {
  const item = audioCache.get(req.params.id);

  if (!item) {
    return res.status(404).send('Audio niet gevonden');
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.send(Buffer.from(item.data));
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
    try {
      const audioUrl = await genAudioViaElevenLabs(
        'Excuses, gesprek niet gevonden.',
        `missing_${Date.now()}`
      );
      twiml.play(audioUrl);
    } catch {
      twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, 'Excuses, gesprek niet gevonden.');
    }

    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  gesprek.status = 'in_gesprek';

  const opening = veiligeTekstVoorTTS(
    `Goedemiddag, u spreekt met Eva van ${process.env.BEDRIJF_NAAM || 'Vaste Lasten Deals'}. Ik bel even heel kort, omdat we ondernemers helpen kijken of hun zakelijke energievoorwaarden nog gunstig zijn. En ik wilde eigenlijk even checken, zit u op dit moment nog variabel, of vast?`
  );

  gesprek.history.push({ role: 'assistant', content: opening });

  try {
    const audioUrl = await genAudioViaElevenLabs(
      opening,
      `${req.params.gesprekId}_opening_${Date.now()}`
    );
    twiml.play(audioUrl);
  } catch (err) {
    log('OPENING ELEVENLABS FOUT, FALLBACK POLLY:', err.message);
    twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, opening);
  }

  twiml.gather({
    input: 'speech',
    language: 'nl-NL',
    speechTimeout: 'auto',
    timeout: 8,
    action: `${process.env.SERVER_URL}/twilio/gather/${req.params.gesprekId}`,
    method: 'POST'
  });

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
    try {
      const audioUrl = await genAudioViaElevenLabs(
        'Gesprek niet gevonden.',
        `missing_gather_${Date.now()}`
      );
      twiml.play(audioUrl);
    } catch {
      twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, 'Gesprek niet gevonden.');
    }

    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const klantTekst = (req.body.SpeechResult || '').trim();

  if (!klantTekst) {
    try {
      await spreekEnLuister(
        twiml,
        'Ik heb u niet helemaal goed verstaan. Kunt u dat nog één keer herhalen?',
        gesprekId
      );
    } catch (err) {
      log('GEEN SPRAAK / ELEVENLABS FOUT:', err.message);
      twiml.say(
        { language: 'nl-NL', voice: 'Polly.Lotte' },
        'Ik heb u niet helemaal goed verstaan. Kunt u dat nog één keer herhalen?'
      );
    }

    return res.type('text/xml').send(twiml.toString());
  }

  gesprek.history.push({ role: 'user', content: klantTekst });
  updateKwalificatieUitTekst(gesprek, klantTekst);

  const klantTekstLower = klantTekst.toLowerCase();

  const optOutWoorden = ['verwijder', 'afmelden', 'bel niet meer', 'nooit meer', 'stop'];
  if (optOutWoorden.some((w) => klantTekstLower.includes(w))) {
    gesprek.status = 'afgerond';
    gesprek.resultaat = 'opt_out';

    try {
      await spreekEnSluitAf(
        twiml,
        'Begrijpelijk, helemaal goed. Dan laat ik het hierbij. Nog een fijne dag.'
      );
    } catch (err) {
      log('OPT OUT ELEVENLABS FOUT:', err.message);
      twiml.say(
        { language: 'nl-NL', voice: 'Polly.Lotte' },
        'Begrijpelijk, helemaal goed. Dan laat ik het hierbij. Nog een fijne dag.'
      );
      twiml.hangup();
    }

    return res.type('text/xml').send(twiml.toString());
  }

  const wilAfspraak = ['afspraak', 'plannen', 'inplannen'].some((w) => klantTekstLower.includes(w));

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
          `Helemaal goed. Dan zet ik hem voor u op ${gekozenSlot.label}. U krijgt daar nog bevestiging van. Fijne dag nog.`
        );

        gesprek.history.push({ role: 'assistant', content: bevestiging });

        try {
          await spreekEnSluitAf(twiml, bevestiging);
        } catch (err) {
          log('AFSPRAAK BEVESTIGING ELEVENLABS FOUT:', err.message);
          twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, bevestiging);
          twiml.hangup();
        }

        return res.type('text/xml').send(twiml.toString());
      } catch (err) {
        log('AGENDA BOEKEN MISLUKT:', err.message);

        try {
          await spreekEnLuister(
            twiml,
            'Het inplannen lukt op dit moment niet direct. Ik kan wel zorgen dat iemand u even terugbelt. Is dat goed?',
            gesprekId
          );
        } catch (e) {
          twiml.say(
            { language: 'nl-NL', voice: 'Polly.Lotte' },
            'Het inplannen lukt op dit moment niet direct. Ik kan wel zorgen dat iemand u even terugbelt. Is dat goed?'
          );
        }

        return res.type('text/xml').send(twiml.toString());
      }
    }

    try {
      await spreekEnLuister(
        twiml,
        'Ik kon het moment niet helemaal goed plaatsen. Wilt u het tijdstip nog één keer noemen?',
        gesprekId
      );
    } catch (err) {
      twiml.say(
        { language: 'nl-NL', voice: 'Polly.Lotte' },
        'Ik kon het moment niet helemaal goed plaatsen. Wilt u het tijdstip nog één keer noemen?'
      );
    }

    return res.type('text/xml').send(twiml.toString());
  }

  if (wilAfspraak && !gesprek.wachtOpSlotKeuze) {
    gesprek.wachtOpSlotKeuze = true;
    gesprek.kwalificatie.appointment_interest = 'ja';

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
        `Helemaal goed. ${slotTekst} Welk moment zou u het beste uitkomen?`
      );

      gesprek.history.push({ role: 'assistant', content: antwoord });

      try {
        await spreekEnLuister(twiml, antwoord, gesprekId);
      } catch (err) {
        twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, antwoord);
      }

      return res.type('text/xml').send(twiml.toString());
    }
  }

  try {
    const antwoord = veiligeTekstVoorTTS(await genereerAntwoord(gesprek));
    gesprek.history.push({ role: 'assistant', content: antwoord });

    if (gesprek.history.length >= 20) {
      gesprek.status = 'afgerond';
      gesprek.resultaat = gesprek.resultaat || 'afgerond';

      try {
        await spreekEnSluitAf(twiml, antwoord);
      } catch (err) {
        twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, antwoord);
        twiml.hangup();
      }
    } else {
      try {
        await spreekEnLuister(twiml, antwoord, gesprekId);
      } catch (err) {
        twiml.say({ language: 'nl-NL', voice: 'Polly.Lotte' }, antwoord);
      }
    }

    return res.type('text/xml').send(twiml.toString());
  } catch (err) {
    log('GATHER FOUT:', err.message);

    try {
      await spreekEnLuister(
        twiml,
        'Excuses, er ging iets mis aan mijn kant. Mag ik u heel kort vragen, zit u op dit moment variabel, of vast?',
        gesprekId
      );
    } catch (e) {
      twiml.say(
        { language: 'nl-NL', voice: 'Polly.Lotte' },
        'Excuses, er ging iets mis aan mijn kant. Mag ik u heel kort vragen, zit u op dit moment variabel, of vast?'
      );
    }

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`AI Beller backend draait op poort ${PORT}`);
});
