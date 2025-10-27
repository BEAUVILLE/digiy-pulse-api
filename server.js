import express from 'express';
import cors from 'cors';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store en mémoire par token
const stores = new Map();

function getStore(token) {
  if (!stores.has(token)) {
    stores.set(token, {
      ca: 0,
      tx: 0,
      transactions: [],
      reservations: [],
      clients: []
    });
  }
  return stores.get(token);
}

// Charge la config d'un token
function loadConfig(token) {
  const configPath = join(__dirname, 'configs', `${token}.json`);
  if (!existsSync(configPath)) {
    console.log(`❌ Config introuvable: ${token}`);
    return null;
  }
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    console.log(`✅ Config chargée: ${config.meta.name}`);
    return config;
  } catch (err) {
    console.error(`❌ Erreur parsing config ${token}:`, err.message);
    return null;
  }
}

// Route racine
app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'DIGIY Pulse API OK 🚀',
    version: '2.0.0',
    features: ['ventes', 'reservations', 'temps-reel']
  });
});

// SSE : flux temps réel
app.get('/events', (req, res) => {
  const token = req.query.token;
  
  if (!token) {
    return res.status(401).json({ ok: false, msg: 'Token requis' });
  }

  const config = loadConfig(token);
  if (!config) {
    return res.status(401).json({ ok: false, msg: 'Token invalide' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const store = getStore(token);
  store.clients.push(res);

  console.log(`🔌 Client SSE connecté pour ${token} (${store.clients.length} actifs)`);

  const bootstrapData = JSON.stringify({
    shop: config.meta.name,
    ca: store.ca,
    tx: store.tx,
    reservations: store.reservations ? store.reservations.length : 0
  });
  res.write(`event: bootstrap\ndata: ${bootstrapData}\n\n`);

  req.on('close', () => {
    const idx = store.clients.indexOf(res);
    if (idx !== -1) store.clients.splice(idx, 1);
    console.log(`❌ Client SSE déconnecté pour ${token} (${store.clients.length} restants)`);
  });
});

// Ingestion de transaction (vente)
app.post('/ingest/tx', (req, res) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, msg: 'Token requis' });
  }

  const token = authHeader.substring(7);
  const config = loadConfig(token);
  
  if (!config) {
    return res.status(401).json({ ok: false, msg: 'Token invalide' });
  }

  const { amount, currency, method, item } = req.body;
  
  if (!amount || amount <= 0) {
    return res.status(400).json({ ok: false, msg: 'Montant invalide' });
  }

  const store = getStore(token);
  store.ca += amount;
  store.tx += 1;
  
  const transaction = {
    amount,
    currency: currency || 'FCFA',
    method: method || 'Espèces',
    item: item || 'Vente',
    timestamp: new Date().toISOString()
  };
  
  store.transactions.push(transaction);

  const eventData = JSON.stringify({ 
    amount: transaction.amount, 
    item: transaction.item,
    timestamp: transaction.timestamp
  });
  
  store.clients.forEach(client => {
    client.write(`event: tx\ndata: ${eventData}\n\n`);
  });

  console.log(`💰 Transaction reçue pour ${token}: ${amount} ${currency} - ${item}`);

  res.json({ ok: true, ca: store.ca, tx: store.tx });
});

// Ingestion de réservation
app.post('/ingest/reservation', (req, res) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, msg: 'Token requis' });
  }

  const token = authHeader.substring(7);
  const config = loadConfig(token);
  
  if (!config) {
    return res.status(401).json({ ok: false, msg: 'Token invalide' });
  }

  const { name, phone, persons, date, time, table, notes } = req.body;
  
  if (!name || !phone || !persons || !time) {
    return res.status(400).json({ ok: false, msg: 'Données incomplètes (name, phone, persons, time requis)' });
  }

  const reservation = {
    id: Date.now().toString(),
    name,
    phone,
    persons: parseInt(persons),
    date: date || new Date().toISOString().split('T')[0],
    time,
    table: table || 'Non assignée',
    notes: notes || '',
    timestamp: new Date().toISOString(),
    status: 'confirmée'
  };

  const store = getStore(token);
  if (!store.reservations) store.reservations = [];
  store.reservations.push(reservation);

  const eventData = JSON.stringify({ 
    name: reservation.name,
    persons: reservation.persons,
    time: reservation.time,
    table: reservation.table,
    timestamp: reservation.timestamp
  });
  
  store.clients.forEach(client => {
    client.write(`event: reservation\ndata: ${eventData}\n\n`);
  });

  console.log(`📅 Réservation reçue pour ${token}: ${name} - ${persons} pers. à ${time}`);

  res.json({ ok: true, reservation });
});

// Stats ventes du jour
app.get('/stats/today', (req, res) => {
  const token = req.query.token;
  
  if (!token) {
    return res.status(401).json({ ok: false, msg: 'Token requis' });
  }

  const config = loadConfig(token);
  if (!config) {
    return res.status(401).json({ ok: false, msg: 'Token invalide' });
  }

  const store = getStore(token);
  const today = new Date().toISOString().split('T')[0];
  
  const todayTransactions = store.transactions.filter(t => {
    const tDate = new Date(t.timestamp).toISOString().split('T')[0];
    return tDate === today;
  });

  const todayCA = todayTransactions.reduce((sum, t) => sum + t.amount, 0);

  res.json({
    ok: true,
    ca: todayCA,
    tx: todayTransactions.length,
    date: today
  });
});

// Stats réservations du jour
app.get('/stats/reservations', (req, res) => {
  const token = req.query.token;
  
  if (!token) {
    return res.status(401).json({ ok: false, msg: 'Token requis' });
  }

  const config = loadConfig(token);
  if (!config) {
    return res.status(401).json({ ok: false, msg: 'Token invalide' });
  }

  const store = getStore(token);
  const today = new Date().toISOString().split('T')[0];
  
  const todayReservations = (store.reservations || []).filter(r => {
    const rDate = r.date || new Date(r.timestamp).toISOString().split('T')[0];
    return rDate === today;
  });

  res.json({
    ok: true,
    count: todayReservations.length,
    reservations: todayReservations.sort((a, b) => a.time.localeCompare(b.time)),
    date: today
  });
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`\n✅ DIGIY Pulse API v2.0 démarrée !`);
  console.log(`🚀 Serveur : http://localhost:${PORT}`);
  console.log(`📊 Features: Ventes + Réservations + Temps réel\n`);
});
