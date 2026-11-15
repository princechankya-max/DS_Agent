import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { sendVerificationEmail } from '../backend/services/email.js';

test('SMTP transport delivers the verification message to a local test server', async () => {
  let message = '';
  const server = createServer(socket => {
    let buffered = '';
    let dataMode = false;
    const dataLines = [];
    socket.write('220 local.test ESMTP\r\n');
    socket.on('data', chunk => {
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || '';
      for (const line of lines) {
        if (dataMode) {
          if (line === '.') {
            dataMode = false;
            message = dataLines.join('\r\n');
            socket.write('250 Message accepted\r\n');
          } else {
            dataLines.push(line.startsWith('..') ? line.slice(1) : line);
          }
        } else if (/^(EHLO|HELO)\b/i.test(line)) {
          socket.write('250-local.test\r\n250 SIZE 10485760\r\n');
        } else if (/^(MAIL FROM|RCPT TO)\b/i.test(line)) {
          socket.write('250 Accepted\r\n');
        } else if (/^DATA\b/i.test(line)) {
          dataMode = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (/^QUIT\b/i.test(line)) {
          socket.write('221 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
  });

  const originalEnv = {};
  const keys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'APP_URL', 'NODE_ENV'];
  for (const key of keys) originalEnv[key] = process.env[key];
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(server.address().port);
    process.env.SMTP_SECURE = 'false';
    process.env.SMTP_USER = '';
    process.env.SMTP_PASS = '';
    process.env.SMTP_FROM = 'DS Agent <no-reply@example.test>';
    process.env.APP_URL = 'https://app.example.test';
    process.env.NODE_ENV = 'test';

    await sendVerificationEmail('user@example.test', 'sample-one-time-token');
    const decodedMessage = message
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    assert.match(decodedMessage, /To: user@example\.test/i);
    assert.match(decodedMessage, /https:\/\/app\.example\.test\/verify-email\?token=sample-one-time-token/);
  } finally {
    for (const key of keys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    if (server.listening) {
      server.close();
      await once(server, 'close');
    }
  }
});
