// Network metrics instrumentation — off by default, enabled with NET_METRICS=true.
//
// Attaches a CDP session to each page and records bytes transferred, cache hits,
// and request counts split by phase (login / deposit / modal). Writes only to
// metrics/ (never events/, to avoid masking hung-shard detection).
//
// Zero network effect: it only observes Network.responseReceived and
// Network.loadingFinished events. Every CDP call is wrapped in try/catch, and
// the session is detached in finally.

import { existsSync, mkdirSync, appendFileSync } from 'fs';
import path from 'path';

const ENABLED = process.env.NET_METRICS === 'true';
const METRICS_DIR = process.env.METRICS_DIR || path.resolve(process.cwd(), 'metrics');

if (ENABLED) {
  mkdirSync(METRICS_DIR, { recursive: true });
}

const activeSessions = new Map();

export async function attachMetrics(page, { account, shard, phase = 'login' } = {}) {
  if (!ENABLED) return null;

  const sessionKey = `${account}-${Date.now()}`;
  const state = {
    account,
    shard,
    phase,
    totalBytes: 0,
    sentBytes: 0,
    wsSentBytes: 0,
    wsRecvBytes: 0,
    requestCount: 0,
    cacheHits: 0,
    byType: {},
    byHost: {},
    byPhase: { login: { bytes: 0, requests: 0, cached: 0 } },
    pending: new Map(),
    sentByRequest: new Map(),
    requestUrls: new Map(),
    posts: [],
    cdp: null,
    detached: false,
    startedAt: Date.now()
  };

  try {
    state.cdp = await page.context().newCDPSession(page);
    await state.cdp.send('Network.enable');

    state.cdp.on('Network.requestWillBeSent', (event) => {
      try {
        if (event.request?.url) state.requestUrls.set(event.requestId, event.request.url);
        if (event.request?.hasPostData) {
          let preview;
          if (process.env.NET_METRICS_POST_PREVIEW === 'true' && event.request.postData) {
            // Redact credential fields: the preview exists to size and identify
            // the anti-bot payload, not to persist logins in metrics/.
            preview = event.request.postData
              .slice(0, 400)
              .replace(/("u(?:Login|Password)"\s*:\s*")[^"]*"/gi, '$1***"');
          }
          state.posts.push({
            url: (event.request.url || '').slice(0, 120),
            bytes: event.request.postData ? event.request.postData.length : 0,
            type: event.type || 'Other',
            preview
          });
        }
      } catch (err) {
        // ignore per-event errors
      }
    });

    state.cdp.on('Network.responseReceived', (event) => {
      try {
        const isCached = event.response.fromDiskCache || event.response.fromPrefetchCache || false;
        state.pending.set(event.requestId, {
          type: event.type || 'Other',
          cached: isCached,
          url: event.response.url
        });
      } catch (err) {
        // ignore per-event errors
      }
    });

    // Request bodies (uploads). With cache hits accounting for downloads, this
    // is the other half of the bill: what each account sends upstream.
    state.cdp.on('Network.dataSent', (event) => {
      try {
        const bytes = event.dataLength || 0;
        state.sentBytes += bytes;
        state.sentByRequest.set(event.requestId, (state.sentByRequest.get(event.requestId) || 0) + bytes);
      } catch (err) {
        // ignore per-event errors
      }
    });

    state.cdp.on('Network.webSocketFrameSent', (event) => {
      try {
        state.wsSentBytes += event.response?.payloadData?.length || 0;
      } catch (err) {
        // ignore per-event errors
      }
    });

    state.cdp.on('Network.webSocketFrameReceived', (event) => {
      try {
        state.wsRecvBytes += event.response?.payloadData?.length || 0;
      } catch (err) {
        // ignore per-event errors
      }
    });

    state.cdp.on('Network.loadingFinished', (event) => {
      try {
        const req = state.pending.get(event.requestId);
        if (!req) return;

        const bytes = event.encodedDataLength || 0;
        state.totalBytes += bytes;
        state.requestCount += 1;
        if (req.cached) state.cacheHits += 1;

        const t = req.type;
        state.byType[t] = (state.byType[t] || 0) + bytes;

        // Which host the bytes came from — first-party page weight vs third-party
        // trackers/widgets. Used to judge whether a blocklist could save anything.
        let host = 'unknown';
        try {
          host = new URL(req.url).host;
        } catch {
          // relative or malformed
        }
        state.byHost[host] = (state.byHost[host] || 0) + bytes;

        if (!state.byPhase[state.phase]) {
          state.byPhase[state.phase] = { bytes: 0, requests: 0, cached: 0 };
        }
        state.byPhase[state.phase].bytes += bytes;
        state.byPhase[state.phase].requests += 1;
        if (req.cached) state.byPhase[state.phase].cached += 1;

        state.pending.delete(event.requestId);
      } catch (err) {
        // ignore per-event errors
      }
    });

    activeSessions.set(sessionKey, state);

    page.on('close', () => {
      try {
        detachSession(sessionKey);
      } catch {
        // ignore
      }
    });
  } catch (err) {
    console.error('[net-metrics] failed to attach CDP session:', err.message);
    return null;
  }

  return {
    setPhase(newPhase) {
      state.phase = newPhase;
      if (!state.byPhase[newPhase]) {
        state.byPhase[newPhase] = { bytes: 0, requests: 0, cached: 0 };
      }
    },
    detach() {
      detachSession(sessionKey);
    },
    getState() {
      return {
        totalBytes: state.totalBytes,
        sentBytes: state.sentBytes,
        wsSentBytes: state.wsSentBytes,
        wsRecvBytes: state.wsRecvBytes,
        requestCount: state.requestCount,
        cacheHits: state.cacheHits,
        byType: { ...state.byType },
        byPhase: JSON.parse(JSON.stringify(state.byPhase)),
        durationMs: Date.now() - state.startedAt
      };
    }
  };
}

function detachSession(sessionKey) {
  const state = activeSessions.get(sessionKey);
  if (!state || state.detached) return;

  try {
    if (state.cdp) {
      state.cdp.detach().catch(() => {});
    }
    state.detached = true;

    writeMetrics(state);
  } catch (err) {
    console.error('[net-metrics] detach error:', err.message);
  } finally {
    activeSessions.delete(sessionKey);
  }
}

function writeMetrics(state) {
  if (!ENABLED) return;

  try {
    const ts = new Date().toISOString();
    const date = ts.split('T')[0];
    const shard = state.shard || 'unknown';
    const file = path.join(METRICS_DIR, `net-${shard}-${date}.jsonl`);

    const topUploads = [...state.sentByRequest.entries()]
      .filter(([, bytes]) => bytes > 4096)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id, bytes]) => ({
        url: (state.requestUrls.get(id) || 'unknown').slice(0, 120),
        kb: +(bytes / 1024).toFixed(1)
      }));

    const topPosts = [...state.posts]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 8);

    const record = {
      ts,
      account: state.account,
      shard,
      totalBytes: state.totalBytes,
      totalMB: +(state.totalBytes / 1048576).toFixed(2),
      sentBytes: state.sentBytes,
      sentMB: +(state.sentBytes / 1048576).toFixed(2),
      wsSentMB: +(state.wsSentBytes / 1048576).toFixed(2),
      wsRecvMB: +(state.wsRecvBytes / 1048576).toFixed(2),
      topUploads,
      postCount: state.posts.length,
      postBytes: state.posts.reduce((sum, p) => sum + p.bytes, 0),
      topPosts,
      requestCount: state.requestCount,
      cacheHits: state.cacheHits,
      cacheHitRate: state.requestCount > 0 ? +(state.cacheHits / state.requestCount).toFixed(2) : 0,
      byType: Object.fromEntries(
        Object.entries(state.byType).map(([k, v]) => [k, +(v / 1048576).toFixed(2)])
      ),
      byHost: Object.fromEntries(
        Object.entries(state.byHost)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([k, v]) => [k, +(v / 1048576).toFixed(2)])
      ),
      byPhase: state.byPhase,
      durationMs: Date.now() - state.startedAt
    };

    appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.error('[net-metrics] write error:', err.message);
  }
}
