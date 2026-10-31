import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import axios from 'axios';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import serialize from 'node-serialize';
import Stripe from 'stripe';
import { pool, prisma } from './db';
import { Account, User } from './models';

const app = express();
app.use(express.json());
app.use(cors({ origin: '*', credentials: true })); // expect: sec/cors-misconfiguration

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const webhookSecret = process.env.WEBHOOK_SECRET ?? '';
const insecureAgent = new https.Agent({ rejectUnauthorized: false }); // expect: sec/tls-verification-disabled

app.get('/users', async (req, res) => {
  const result = await pool.query(`SELECT * FROM users WHERE name = '${req.query.name}'`); // expect: sec/sql-injection
  res.json(result.rows);
});

app.get('/users/safe', async (req, res) => {
  const result = await pool.query('SELECT * FROM users WHERE name = $1', [req.query.name]);
  const limit = 50;
  const recent = await pool.query(`SELECT * FROM users ORDER BY created_at DESC LIMIT ${limit}`);
  res.json([...result.rows, ...recent.rows]);
});

app.post('/ping', (req, res) => {
  const host = req.body.host;
  exec(`ping -c 1 ${host}`, (_err, out) => res.send(out)); // expect: sec/command-injection
});

app.get('/proxy', async (req, res) => {
  const upstream = await axios.get(req.query.url as string); // expect: sec/ssrf rel/http-call-without-timeout
  res.send(upstream.data);
});

app.get('/partner/:id', async (req, res) => {
  const partner = await axios.get(`https://partners.example.com/v1/items/${req.params.id}`, { timeout: 5000 });
  res.send(partner.data);
});

app.get('/files', (req, res) => {
  const data = fs.readFileSync(`./uploads/${req.query.name}`); // expect: sec/path-traversal perf/sync-io-in-request-handler
  res.send(data);
});

app.get('/login/callback', (req, res) => {
  res.redirect(req.query.next as string); // expect: sec/open-redirect
});

app.get('/logout', (_req, res) => {
  res.redirect('/');
});

app.post('/import', (req, res) => {
  const obj = serialize.unserialize(req.body.payload); // expect: sec/unsafe-deserialization
  res.json(obj);
});

app.post('/calc', (req, res) => {
  const result = eval(req.body.expression); // expect: sec/code-injection
  res.json({ result });
});

app.post('/token', (req, res) => {
  const token = jwt.sign({ id: req.body.id }, 'super-secret-signing-key'); // expect: sec/hardcoded-signing-secret
  res.json({ token });
});

app.get('/verify', (req, res) => {
  const payload = jwt.verify(String(req.query.t), process.env.JWT_SECRET!, { algorithms: ['HS256', 'none'] }); // expect: sec/jwt-insecure
  res.json(payload);
});

function makeResetToken() {
  const resetToken = Math.random().toString(36).slice(2); // expect: sec/insecure-random
  return resetToken;
}

function jitterDelay() {
  const delay = Math.random() * 100;
  return delay;
}

function hashPassword(password: string) {
  return crypto.createHash('md5').update(password).digest('hex'); // expect: sec/weak-password-hash
}

function etag(body: string) {
  return crypto.createHash('sha1').update(body).digest('hex');
}

app.post('/charge', async (req, res) => {
  const intent = await stripe.paymentIntents.create({ amount: req.body.amount, currency: 'usd' }); // expect: rel/payment-without-idempotency-key
  res.json(intent);
});

app.post('/charge/safe', async (req, res) => {
  const intent = await stripe.paymentIntents.create({ amount: req.body.amount, currency: 'usd' }, { idempotencyKey: req.body.orderId });
  res.json(intent);
});

app.post('/register', async (req, res) => {
  const user = await User.create(req.body); // expect: sec/mass-assignment
  console.log('registered', user.email, req.body.password); // expect: sec/sensitive-data-in-logs
  res.json({ id: user.id });
});

app.post('/login', async (req, res) => {
  const user = await User.findOne({ email: req.body.email, password: req.body.password }); // expect: sec/nosql-injection
  res.json({ ok: !!user });
});

app.get('/search', async (req, res) => {
  const pattern = new RegExp(req.query.q as string); // expect: sec/regex-injection
  res.json(await User.find({ email: pattern }));
});

app.post('/orders/bulk', async (req, res) => {
  const orders = [];
  for (const id of req.body.ids) {
    const order = await prisma.order.findUnique({ where: { id } }); // expect: perf/query-in-loop
    orders.push(order);
  }
  res.json(orders);
});

app.post('/orders/bulk-fast', async (req, res) => {
  const orders = await prisma.order.findMany({ where: { id: { in: req.body.ids } } });
  res.json(orders);
});

app.get('/stats', async (_req, res) => {
  const total = (await prisma.user.findMany()).length; // expect: perf/load-all-to-count perf/unbounded-query
  res.json({ total });
});

app.post('/withdraw', async (req, res) => {
  const account = await Account.findById(req.body.accountId);
  account!.balance = account!.balance! - req.body.amount; // expect: rel/race-condition-read-modify-write
  await account!.save();
  res.json({ ok: true });
});

app.post('/webhook', (req, res) => {
  const signature = req.headers['x-signature'];
  if (signature === webhookSecret) { // expect: sec/timing-unsafe-comparison
    res.sendStatus(200);
  } else res.sendStatus(401);
});

app.post('/notify', async (req, res) => {
  req.body.recipients.forEach(async (r: string) => { // expect: rel/async-foreach
    await axios.post('https://hooks.example.com/notify', { r }, { timeout: 3000 });
  });
  try {
    fs.chmodSync('/tmp/notify.lock', 0o777); // expect: sec/world-writable-permissions perf/sync-io-in-request-handler
  } catch (e) {} // expect: rel/swallowed-exception
  res.sendStatus(202);
});

export function legacyBuffer() {
  debugger; // expect: qual/debug-statement
  return new Buffer(16); // expect: sec/deprecated-buffer-constructor
}

app.listen(3000);
export { app, insecureAgent, makeResetToken, jitterDelay, hashPassword, etag };
