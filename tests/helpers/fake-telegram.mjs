// A local stand-in for the Telegram Bot API.
//
// The monitor agent and the status bot are separate processes, so the only way
// to assert what they send without touching the real Telegram is to point
// TELEGRAM_API_BASE at this server. Every call is recorded in order.
//
//   const tg = await startFakeTelegram();
//   tg.enqueue('shard-1', '699397575');   // simulate an admin typing
//   tg.messages();                        // [{ chatId, text }]
//   tg.photos();                          // [{ chatId, caption, fileName }]

import { createServer } from 'http';

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// Minimal multipart reader: enough for the fields we send.
function parseMultipart(body, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '');
  if (!boundaryMatch) return {};
  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const parts = body.toString('latin1').split(boundary);
  const fields = {};
  for (const part of parts) {
    const nameMatch = /name="([^"]+)"/.exec(part);
    if (!nameMatch) continue;
    const valueStart = part.indexOf('\r\n\r\n');
    const valueEnd = part.lastIndexOf('\r\n');
    if (valueStart === -1 || valueEnd === -1) continue;
    fields[nameMatch[1]] = part.slice(valueStart + 4, valueEnd);
  }
  return fields;
}

export async function startFakeTelegram({
  failMessageSends = 0,
  failPhotoSends = 0,
  failPhotoChatIds = []
} = {}) {
  const calls = [];
  const updates = [];
  let updateSeq = 0;
  let messageFailuresLeft = failMessageSends;
  let photoFailuresLeft = failPhotoSends;

  function json(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const method = url.pathname.split('/').pop();

    if (method === 'getUpdates') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const pending = updates.filter((update) => (offset === -1 ? true : update.update_id >= offset));
      const result = offset === -1 ? pending.slice(-1) : pending;
      calls.push({ kind: 'getUpdates', offset });
      // Answer promptly instead of long-polling for 30s.
      setTimeout(() => json(res, 200, { ok: true, result }), 20);
      return;
    }

    const raw = await readBody(req);

    if (method === 'sendMessage') {
      const payload = JSON.parse(raw.toString('utf8') || '{}');
      calls.push({ kind: 'message', chatId: String(payload.chat_id), text: payload.text });
      if (messageFailuresLeft > 0) {
        messageFailuresLeft -= 1;
        json(res, 500, { ok: false, description: 'simulated failure' });
        return;
      }
      json(res, 200, { ok: true, result: { message_id: calls.length } });
      return;
    }

    if (method === 'sendPhoto') {
      const fields = parseMultipart(raw, req.headers['content-type']);
      const chatId = String(fields.chat_id);
      calls.push({
        kind: 'photo',
        chatId,
        caption: fields.caption || '',
        fileName: (/filename="([^"]+)"/.exec(raw.toString('latin1')) || [])[1] || '',
        bytes: raw.length
      });
      if (failPhotoChatIds.includes(chatId)) {
        json(res, 500, { ok: false, description: 'simulated recipient failure' });
        return;
      }
      if (photoFailuresLeft > 0) {
        photoFailuresLeft -= 1;
        json(res, 500, { ok: false, description: 'simulated failure' });
        return;
      }
      json(res, 200, { ok: true, result: { message_id: calls.length } });
      return;
    }

    if (method === 'sendDocument') {
      const fields = parseMultipart(raw, req.headers['content-type']);
      calls.push({
        kind: 'document',
        chatId: String(fields.chat_id),
        caption: fields.caption || '',
        fileName: (/filename="([^"]+)"/.exec(raw.toString('latin1')) || [])[1] || '',
        body: fields.document || '',
        bytes: raw.length
      });
      json(res, 200, { ok: true, result: { message_id: calls.length } });
      return;
    }

    json(res, 200, { ok: true, result: [] });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    enqueue(text, chatId = '699397575', atSeconds = Math.floor(Date.now() / 1000)) {
      updateSeq += 1;
      updates.push({
        update_id: updateSeq,
        message: { message_id: updateSeq, date: atSeconds, text, chat: { id: Number(chatId) } }
      });
      return updateSeq;
    },
    // Drop every update queued so far, as if the bot had already consumed them.
    clearUpdates() {
      updates.length = 0;
    },
    messages() {
      return calls.filter((call) => call.kind === 'message');
    },
    texts() {
      return calls.filter((call) => call.kind === 'message').map((call) => call.text);
    },
    photos() {
      return calls.filter((call) => call.kind === 'photo');
    },
    documents() {
      return calls.filter((call) => call.kind === 'document');
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
