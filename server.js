'use strict';

const express = require('express');
const zlib    = require('zlib');
const { randomUUID } = require('crypto');

// ── Config ─────────────────────────────────────────────────────────────────

const PORT       = process.env.PORT       || 3000;
const SECRET     = process.env.MCP_SECRET || '';  // set in Render env vars
const FB_PROJECT = process.env.FB_PROJECT || 'pacte-agenda-6c7cf';
const FB_API_KEY = process.env.FB_API_KEY || 'AIzaSyDt3DBRi_T6qoW14dpPXg1ZcVjVUV7RW6c';

// ── Firebase reader ────────────────────────────────────────────────────────

async function fbGet(docPath) {
  const url = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents/${docPath}?key=${FB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firebase ${res.status}: ${docPath}`);
  return res.json();
}

let dataCache = null;
let cacheTime = 0;
const CACHE_TTL = 60_000; // 1 min

async function readData() {
  const now = Date.now();
  if (dataCache && now - cacheTime < CACHE_TTL) return dataCache;

  const meta   = await fbGet('pacte/agenda');
  const nChunks = parseInt(meta.fields?.chunks?.integerValue || '1');

  let b64 = '';
  for (let i = 0; i < nChunks; i++) {
    const chunk = await fbGet(`pacte/chunk_${i}`);
    b64 += chunk.fields?.data?.stringValue || '';
  }

  const buf = await new Promise((resolve, reject) => {
    zlib.gunzip(Buffer.from(b64, 'base64'), (err, r) => err ? reject(err) : resolve(r));
  });

  const data = JSON.parse(buf.toString('utf-8'));
  dataCache = {
    items:      Array.isArray(data.items)      ? data.items      : [],
    todos:      Array.isArray(data.todos)       ? data.todos      : [],
    organismes: Array.isArray(data.organismes)  ? data.organismes : []
  };
  cacheTime = now;
  return dataCache;
}

// ── Tool logic (same as local mcp-server.js) ───────────────────────────────

function itemToText(item) {
  const paid = item.remuPayStatut === 'paye';
  return [
    `ID: ${item.id}`,
    `Titre: ${item.title}`,
    `Date: ${item.date}${item.dateEnd && item.dateEnd !== item.date ? ' → ' + item.dateEnd : ''}`,
    item.time       ? `Heure: ${item.time}${item.timeEnd ? ' – ' + item.timeEnd : ''}` : null,
    item.remuOrganisme ? `Organisme: ${item.remuOrganisme}` : null,
    item.remuStatut    ? `Type: ${item.remuStatut}` : null,
    item.remuBrut      ? `Montant: ${item.remuBrut} €` : null,
    item.remuBrut      ? `Payé: ${paid ? 'Oui' : 'Non'}${item.remuPayDate ? ' (le ' + item.remuPayDate + ')' : ''}` : null,
    item.description   ? `Note: ${item.description}` : null,
  ].filter(Boolean).join('\n');
}

async function callTool(name, args) {
  const data = await readData();

  if (name === 'agenda_lire_evenements') {
    const { dateDebut, dateFin, limite = 100 } = args || {};
    let items = data.items.filter(item => {
      if (!item.date) return false;
      const end = item.dateEnd || item.date;
      if (dateDebut && end < dateDebut) return false;
      if (dateFin && item.date > dateFin) return false;
      return true;
    });
    items = items.sort((a, b) => a.date < b.date ? -1 : 1).slice(0, limite);
    if (!items.length) return 'Aucun événement trouvé.';
    return `${items.length} événement(s) :\n\n` + items.map(itemToText).join('\n────────────────\n');
  }

  if (name === 'agenda_resume_ca') {
    const { annee, mois } = args || {};
    const y = annee || new Date().getFullYear();
    const items = data.items.filter(item => {
      if (!item.date || !item.remuBrut) return false;
      if (parseInt(item.date.slice(0, 4)) !== y) return false;
      if (mois && parseInt(item.date.slice(5, 7)) !== mois) return false;
      return true;
    });
    if (!items.length) return `Aucun événement rémunéré pour ${mois ? String(mois).padStart(2,'0') + '/' : ''}${y}.`;

    const total     = items.reduce((s, i) => s + (Number(i.remuBrut) || 0), 0);
    const encaisse  = items.filter(i => i.remuPayStatut === 'paye').reduce((s, i) => s + (Number(i.remuBrut) || 0), 0);
    const parOrg    = {};
    for (const item of items) {
      const org = item.remuOrganisme || 'Non renseigné';
      if (!parOrg[org]) parOrg[org] = { total: 0, encaisse: 0, nb: 0 };
      parOrg[org].total += Number(item.remuBrut) || 0;
      if (item.remuPayStatut === 'paye') parOrg[org].encaisse += Number(item.remuBrut) || 0;
      parOrg[org].nb++;
    }
    const orgsLines = Object.entries(parOrg)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([org, s]) => `  • ${org}: ${s.total.toFixed(2)} € (${s.nb} évt, encaissé: ${s.encaisse.toFixed(2)} €)`)
      .join('\n');

    return [
      `📊 Résumé CA – ${mois ? String(mois).padStart(2,'0') + '/' : ''}${y}`,
      ``,
      `Total brut   : ${total.toFixed(2)} €`,
      `Encaissé     : ${encaisse.toFixed(2)} €`,
      `En attente   : ${(total - encaisse).toFixed(2)} €`,
      `Nb événements: ${items.length}`,
      ``,
      `Par organisme :`,
      orgsLines
    ].join('\n');
  }

  if (name === 'agenda_lire_organismes') {
    if (!data.organismes.length) return 'Aucun organisme enregistré.';
    return data.organismes
      .sort((a, b) => a.nom.localeCompare(b.nom))
      .map(o => [
        `Nom  : ${o.nom}`,
        o.siret    ? `SIRET: ${o.siret}` : null,
        o.adresse  ? `Adresse: ${o.adresse}${o.codePostal ? ', ' + o.codePostal : ''}${o.ville ? ' ' + o.ville : ''}` : null,
        o.email    ? `Email: ${o.email}` : null,
        o.telephone ? `Tél: ${o.telephone}` : null,
      ].filter(Boolean).join('\n'))
      .join('\n────────────────\n');
  }

  if (name === 'agenda_lire_todos') {
    const { filtre = 'toutes' } = args || {};
    let todos = data.todos;
    if (filtre === 'en_cours')  todos = todos.filter(t => !t.completed);
    if (filtre === 'terminees') todos = todos.filter(t => t.completed);
    if (!todos.length) return 'Aucune tâche.';
    return todos.map(t => {
      const s = t.completed ? '✅' : '⬜';
      const p = t.priority === 'high' ? '🔴' : t.priority === 'low' ? '🟢' : '🟡';
      return `${s} ${p} ${t.text}`;
    }).join('\n');
  }

  return `Outil inconnu: ${name}`;
}

// ── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'agenda_lire_evenements',
    description: 'Lit les événements de l\'agenda PACTE (rendez-vous, formations, activités).',
    inputSchema: {
      type: 'object',
      properties: {
        dateDebut: { type: 'string', description: 'Date début YYYY-MM-DD (optionnel)' },
        dateFin:   { type: 'string', description: 'Date fin YYYY-MM-DD (optionnel)' },
        limite:    { type: 'number', description: 'Nombre max (défaut 100)' }
      }
    }
  },
  {
    name: 'agenda_resume_ca',
    description: 'Résumé du chiffre d\'affaires PACTE par période et organisme.',
    inputSchema: {
      type: 'object',
      properties: {
        annee: { type: 'number', description: 'Année (défaut: année en cours)' },
        mois:  { type: 'number', description: 'Mois 1-12 (optionnel)' }
      }
    }
  },
  {
    name: 'agenda_lire_organismes',
    description: 'Liste les organismes clients PACTE.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'agenda_lire_todos',
    description: 'Lit les tâches PACTE.',
    inputSchema: {
      type: 'object',
      properties: {
        filtre: {
          type: 'string',
          enum: ['toutes', 'en_cours', 'terminees'],
          description: '"toutes" (défaut), "en_cours" ou "terminees"'
        }
      }
    }
  }
];

// ── MCP over SSE ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Optional secret check
function checkSecret(req, res) {
  if (!SECRET) return true;
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
  if (token !== SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Active SSE sessions: sessionId → res
const sseClients = new Map();

// GET /sse  — establish SSE connection
app.get('/sse', (req, res) => {
  if (!checkSecret(req, res)) return;

  const sessionId = randomUUID();
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Send the endpoint URL for this session
  const msgUrl = `/messages?sessionId=${sessionId}${SECRET ? '&token=' + SECRET : ''}`;
  res.write(`event: endpoint\ndata: ${msgUrl}\n\n`);

  sseClients.set(sessionId, res);

  req.on('close', () => sseClients.delete(sessionId));
});

// POST /messages  — receive JSON-RPC from Claude
app.post('/messages', async (req, res) => {
  if (!checkSecret(req, res)) return;

  const { sessionId } = req.query;
  const sse = sseClients.get(sessionId);
  if (!sse) return res.status(404).json({ error: 'Session not found' });

  res.status(202).json({ status: 'accepted' });

  const msg    = req.body;
  const { id, method, params } = msg;

  async function sendSSE(payload) {
    sse.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  try {
    if (method === 'initialize') {
      await sendSSE({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'pacte-agenda', version: '1.0.0' }
        }
      });
      return;
    }

    if (method === 'notifications/initialized') return;

    if (method === 'ping') {
      await sendSSE({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      await sendSSE({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const text = await callTool(name, args);
      await sendSSE({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text }] }
      });
      return;
    }

    await sendSSE({
      jsonrpc: '2.0', id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  } catch (err) {
    await sendSSE({
      jsonrpc: '2.0', id,
      error: { code: -32603, message: err.message }
    });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', name: 'pacte-agenda-mcp', version: '1.0.0' });
});

app.listen(PORT, () => {
  console.log(`PACTE Agenda MCP server (HTTP/SSE) on port ${PORT}`);
  if (SECRET) console.log('Auth: Bearer token required');
});
