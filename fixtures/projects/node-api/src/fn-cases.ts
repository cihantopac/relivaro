import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';
import tar from 'tar-stream';

const JWT_SECRET = 'secret';
const corsOptions = { origin: '*', credentials: true };

function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, '');
}

export const fnCases = express.Router();

fnCases.get('/sh', (req, res) => {
  spawn('sh', ['-c', req.query.c as string]); // expect: sec/command-injection
  spawn('sh', ['-c', 'ls -l']);
  res.end();
});

fnCases.get('/greet', (req, res) => {
  res.send('<p>' + req.query.q + '</p>'); // expect: sec/xss
});

fnCases.get('/greet-template', (req, res) => {
  res.send(`<p>${req.query.q}</p>`); // expect: sec/xss
});

fnCases.get('/greet-escaped', (req, res) => {
  res.send(escapeHtml(req.query.q));
});

fnCases.get('/greet-json', (req, res) => {
  res.json({ q: req.query.q });
});

fnCases.use(require('cors')({ origin: '*', credentials: true })); // expect: sec/cors-misconfiguration
fnCases.use(cors(corsOptions)); // expect: sec/cors-misconfiguration
fnCases.use(cors({ origin: 'https://app.example', credentials: true }));

export function issueToken(payload: object) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' }); // expect: sec/hardcoded-signing-secret
}

export function issueTokenWith(payload: object, JWT_SECRET: string) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

export function issueTokenFromEnv(payload: object) {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: '1h' });
}

export const extractor = tar.extract();

export function writeEntry(dest: string, entry: { path: string }) {
  return fs.createWriteStream(path.join(dest, entry.path)); // expect: sec/path-traversal
}

export function writeEntryChecked(dest: string, entry: { path: string }) {
  const target = path.resolve(dest, entry.path);
  if (!target.startsWith(path.resolve(dest) + path.sep)) throw new Error('entry escapes the destination');
  return fs.createWriteStream(target);
}
