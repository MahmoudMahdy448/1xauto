export function parseProxyUrl(url) {
  if (!url) {
    return null;
  }

  return { server: url };
}
