require('dotenv').config();
const express = require('express');
const http = require('http');
const mqtt = require('mqtt');
const mysql = require('mysql2/promise');
const { MongoClient } = require('mongodb');
const { createClient } = require('redis');
const Minio = require('minio');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const PORT = Number(process.env.PORT || 3000);
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 120);
const history = [];
const states = {
  mariadb: { status: 'checking', checkedAt: null, error: null, tables: [], tableCount: 0, estimatedRows: 0 },
  mongodb: { status: 'checking', checkedAt: null, error: null, databases: [], databaseCount: 0, collectionCount: 0, estimatedDocuments: 0 },
  redis: { status: 'checking', checkedAt: null, error: null, version: null, uptimeSeconds: null, usedMemory: null, dbSize: 0, keys: [] },
  minio: { status: 'checking', checkedAt: null, error: null, bucketCount: 0, buckets: [], objectSample: [] },
  mqtt: { status: 'connecting', checkedAt: null, error: null, topic: process.env.MQTT_TOPIC || '#', lastMessageAt: null, messageCount: 0, topicCount: 0, topics: [] }
};
let mqttClient;
let mariadbPool;
let mongoClient;
let redisClient;
let minioClient;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/overview', (_req, res) => {
  res.json({ generatedAt: new Date().toISOString(), services: states, recentMessages: history.slice(0, 8) });
});
app.get('/api/:service', (req, res) => {
  const service = req.params.service.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(states, service)) return res.status(404).json({ error: 'Serviço não encontrado' });
  res.json(states[service]);
});
app.get('/api/history', (_req, res) => res.json(history));
app.get('/api/status', (_req, res) => res.json({ service: 'dashboard-grupo1', services: Object.fromEntries(Object.entries(states).map(([k,v]) => [k, v.status])) }));

function setState(service, patch) {
  states[service] = { ...states[service], ...patch, checkedAt: new Date().toISOString() };
  io.emit('service-update', { service, data: states[service] });
}
function safeError(err) {
  // Não devolve URI, usuário, senha ou detalhes de conexão para o navegador.
  const msg = String(err && err.message || 'Falha de conexão');
  return msg.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[URI ocultada]').replace(/(password|passwd|pwd)=([^&\s]+)/gi, '$1=[oculto]').slice(0, 220);
}

async function checkMariaDB() {
  try {
    if (!mariadbPool) mariadbPool = mysql.createPool({
      host: process.env.MARIADB_HOST, port: Number(process.env.MARIADB_PORT || 3306),
      user: process.env.MARIADB_USER, password: process.env.MARIADB_PASSWORD,
      database: process.env.MARIADB_DATABASE, waitForConnections: true, connectionLimit: 3,
      connectTimeout: 8000
    });
    const [rows] = await mariadbPool.query(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, COALESCE(TABLE_ROWS, 0) AS estimatedRows
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [process.env.MARIADB_DATABASE]
    );
    const tables = rows.map(r => ({ name: r.name, type: r.type, estimatedRows: Number(r.estimatedRows || 0) }));
    setState('mariadb', { status: 'online', error: null, database: process.env.MARIADB_DATABASE, tables, tableCount: tables.length, estimatedRows: tables.reduce((a, t) => a + t.estimatedRows, 0) });
  } catch (err) { setState('mariadb', { status: 'offline', error: safeError(err), tables: [], tableCount: 0, estimatedRows: 0 }); }
}

async function checkMongoDB() {
  try {
    if (!mongoClient) { mongoClient = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 }); await mongoClient.connect(); }
    const admin = mongoClient.db('admin');
    const result = await admin.command({ listDatabases: 1, nameOnly: true });
    const databases = [];
    let collectionCount = 0, estimatedDocuments = 0;
    for (const dbInfo of (result.databases || []).filter(d => !['admin','config','local'].includes(d.name)).slice(0, 8)) {
      const db = mongoClient.db(dbInfo.name);
      const collections = await db.listCollections({}, { nameOnly: true }).toArray();
      const items = [];
      for (const collection of collections.slice(0, 20)) {
        let count = 0;
        try { count = await db.collection(collection.name).estimatedDocumentCount(); } catch (_) {}
        items.push({ name: collection.name, estimatedDocuments: count });
        estimatedDocuments += count;
      }
      collectionCount += collections.length;
      databases.push({ name: dbInfo.name, collectionCount: collections.length, collections: items });
    }
    setState('mongodb', { status: 'online', error: null, databases, databaseCount: databases.length, collectionCount, estimatedDocuments });
  } catch (err) {
    if (mongoClient) { try { await mongoClient.close(); } catch (_) {} mongoClient = null; }
    setState('mongodb', { status: 'offline', error: safeError(err), databases: [], databaseCount: 0, collectionCount: 0, estimatedDocuments: 0 });
  }
}

async function checkRedis() {
  try {
    if (!redisClient || !redisClient.isOpen) {
      redisClient = createClient({ socket: { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT || 6379), connectTimeout: 8000, reconnectStrategy: false }, password: process.env.REDIS_PASSWORD });
      redisClient.on('error', () => {});
      await redisClient.connect();
    }
    const [pong, info, dbSize] = await Promise.all([redisClient.ping(), redisClient.info(), redisClient.dbSize()]);
    const parseInfo = (key) => { const m = info.match(new RegExp(`^${key}:(.+)$`, 'm')); return m ? m[1].trim() : null; };
    const keys = [];
    for await (const key of redisClient.scanIterator({ COUNT: 25 })) {
      let type = 'unknown'; try { type = await redisClient.type(key); } catch (_) {}
      keys.push({ name: key, type });
      if (keys.length >= 25) break;
    }
    setState('redis', { status: pong === 'PONG' ? 'online' : 'offline', error: null, version: parseInfo('redis_version'), uptimeSeconds: Number(parseInfo('uptime_in_seconds') || 0), usedMemory: parseInfo('used_memory_human'), dbSize, keys });
  } catch (err) {
    if (redisClient) { try { if (redisClient.isOpen) await redisClient.quit(); } catch (_) {} redisClient = null; }
    setState('redis', { status: 'offline', error: safeError(err), keys: [], dbSize: 0 });
  }
}

async function checkMinio() {
  try {
    if (!minioClient) minioClient = new Minio.Client({ endPoint: process.env.MINIO_ENDPOINT, port: Number(process.env.MINIO_PORT || 9000), useSSL: String(process.env.MINIO_USE_SSL).toLowerCase() === 'true', accessKey: process.env.MINIO_ACCESS_KEY, secretKey: process.env.MINIO_SECRET_KEY });
    const buckets = await minioClient.listBuckets();
    const objectSample = [];
    for (const bucket of buckets.slice(0, 10)) {
      let sampled = 0;
      const stream = minioClient.listObjects(bucket.name, '', true);
      await new Promise((resolve) => {
        stream.on('data', obj => { if (objectSample.length < 40) objectSample.push({ bucket: bucket.name, name: obj.name, size: Number(obj.size || 0), lastModified: obj.lastModified || null }); sampled++; if (sampled >= 5) stream.destroy(); });
        stream.on('error', resolve); stream.on('end', resolve); stream.on('close', resolve);
      });
    }
    setState('minio', { status: 'online', error: null, bucketCount: buckets.length, buckets: buckets.map(b => ({ name: b.name, creationDate: b.creationDate })), objectSample });
  } catch (err) { setState('minio', { status: 'offline', error: safeError(err), bucketCount: 0, buckets: [], objectSample: [] }); }
}

function connectMQTT() {
  const url = `mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT || 1883}`;
  mqttClient = mqtt.connect(url, { clientId: process.env.MQTT_CLIENT_ID || 'dashboard_grupo1', username: process.env.MQTT_USER || undefined, password: process.env.MQTT_PASSWORD || undefined, clean: true, connectTimeout: 12000, reconnectPeriod: 5000, keepalive: 30 });
  mqttClient.on('connect', () => {
    const topic = process.env.MQTT_TOPIC || '#';
    setState('mqtt', { status: 'online', error: null, topic });
    mqttClient.subscribe(topic, { qos: 0 }, err => { if (err) setState('mqtt', { status: 'offline', error: safeError(err) }); });
  });
  mqttClient.on('reconnect', () => setState('mqtt', { status: 'connecting' }));
  mqttClient.on('offline', () => setState('mqtt', { status: 'offline' }));
  mqttClient.on('error', err => setState('mqtt', { status: 'offline', error: safeError(err) }));
  mqttClient.on('message', (topic, buffer) => {
    const raw = buffer.toString('utf8'); let payload;
    try { payload = JSON.parse(raw); } catch (_) { payload = { value: raw }; }
    const message = { topic, payload, receivedAt: new Date().toISOString() };
    history.unshift(message); if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
    const topics = new Set(history.map(m => m.topic));
    setState('mqtt', { status: 'online', lastMessageAt: message.receivedAt, messageCount: states.mqtt.messageCount + 1, topicCount: topics.size, topics: [...topics].slice(0, 40) });
    io.emit('mqtt-message', message);
  });
}

async function refreshAll() { await Promise.allSettled([checkMariaDB(), checkMongoDB(), checkRedis(), checkMinio()]); }
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard Grupo 1 disponível na porta ${PORT}`);
  connectMQTT();
  refreshAll();
  setInterval(refreshAll, Number(process.env.REFRESH_INTERVAL_MS || 30000)).unref();
});

async function shutdown() {
  try { if (mqttClient) mqttClient.end(true); if (mariadbPool) await mariadbPool.end(); if (mongoClient) await mongoClient.close(); if (redisClient?.isOpen) await redisClient.quit(); } catch (_) {}
  server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
