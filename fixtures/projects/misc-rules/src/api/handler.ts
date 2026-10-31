import express from 'express';
import crypto from 'node:crypto';
import libxml from 'libxmljs2';

const app = express();

app.post('/admin/reset', (req, res) => {
  if (!req.body.confirm) process.exit(1); // expect: rel/process-exit-in-request-path
  res.send('ok');
});

app.post('/xml', (req, res) => {
  const doc = libxml.parseXml(req.body.xml, { noent: true }); // expect: sec/xxe
  res.send(doc.toString());
});

export function encryptLegacy(data: string, key: Buffer) {
  const cipher = crypto.createCipheriv('des-ede3-cbc', key, Buffer.alloc(8)); // expect: sec/weak-cipher
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function encryptModern(data: string, key: Buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([iv, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
}
