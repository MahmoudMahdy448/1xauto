export function parseProxyUrl(url) {
  if (url == null || url === '') {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `Invalid PROXY_URL: "${maskProxyPassword(url)}". Expected format: http://[user:pass@]host:port`
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid PROXY_URL protocol "${parsed.protocol}". Only http:// and https:// are supported.`
    );
  }

  if (!parsed.hostname) {
    throw new Error(
      'Invalid PROXY_URL: missing host. Expected format: http://[user:pass@]host:port'
    );
  }

  const config = {
    server: `${parsed.protocol}//${parsed.host}`
  };

  if (parsed.username) {
    config.username = decodeURIComponent(parsed.username);
  }

  if (parsed.password) {
    config.password = decodeURIComponent(parsed.password);
  }

  return config;
}

export function maskProxyPassword(url) {
  if (url == null) {
    return url;
  }
  return String(url).replace(/(:\/\/[^:]+):([^@]+)@/, '$1:***@');
}
