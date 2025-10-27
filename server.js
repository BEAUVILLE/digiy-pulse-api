import express from 'express';
import cors from 'cors';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3100;

app.use(cors());
app.use(express.json());

const stores = new Map();

function loadConfig(token) {
  const configPath = join(__dirname, 'configs', `${token}.json`);
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function getStore(token) {
  if (!stores.has(token)) {
    stores.set(token, { transactions: [], clients: [] });
  }
  return stores.get(token);
}

function getTodayStats(token) {
  const store = getStore(token);
  const today = new Date().toISOString().split('T')[0];
  const todayTx = store.transactions.filter(tx => {
    const txDate = new Date(tx.timestamp).toISOString().split('T')[0];
    return txDate === today;
  });
  const ca = todayTx.reduce((sum, tx) => sum + (tx.amount || 0), 0);
  const tx = todayTx.length;
  return { ok: true, ca, tx, date: today };
}

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'DIGIY Pulse API OK 🚀', version: '1.0.0' });
});

app.get('/stats/today', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).json({ ok: false, msg: 'Token requis' });
  const config = loadConfig(token);
  if (!config) return res.status(401).json({ ok: false, msg: 'Token invalide' });
  res.json(getTodayStats(token));
});

app.get('/events', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).json({ ok: false, msg: 'Token requis' });
  const config = loadConfig(token);
  if (!config) return res.status(401).json({ ok: false, msg: 'Token invalide' });
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`event: bootstrap\ndata: ${JSON.stringify({ token, shop: config.meta?.name || 'Shop' })}\n\n`);
  
  const store = getStore(token);
  store.clients.push(res);
  req.on('close', () => {
    const index = store.clients.indexOf(res);
    if (index !== -1) store.clients.splice(index, 1);
  });
});

app.post('/ingest/tx', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, msg: 'Token requis' });
  }
  const token = authHeader.substring(7);
  const config = loadConfig(token);
  if (!config) return res.status(401).json({ ok: false, msg: 'Token invalide' });
  
  const { amount, currency, method, item } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ ok: false, msg: 'Montant invalide' });
  }
  
  const tx = {
    id: Date.now().toString(),
    amount,
    currency: currency || 'EUR',
    method: method || 'Cash',
    item: item || 'Vente',
    timestamp: new Date().toISOString()
  };
  
  const store = getStore(token);
  store.transactions.push(tx);
  
  const eventData = JSON.stringify({ amount: tx.amount, item: tx.item, method: tx.method, timestamp: tx.timestamp });
  store.clients.forEach(client => client.write(`event: tx\ndata: ${eventData}\n\n`));
  
  console.log(`💰 Transaction: ${token} - ${amount} ${currency}`);
  res.json({ ok: true, tx });
});

app.listen(PORT, () => {
  console.log(`\n✅ DIGIY Pulse API démarrée !`);
  console.log(`🚀 Serveur : http://localhost:${PORT}\n`);
});
