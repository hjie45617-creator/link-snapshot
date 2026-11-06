const dns = require('node:dns').promises;
const net = require('node:net');

const DNS_CACHE_TTL_MS = 60_000;
const dnsCache = new Map();

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIPv6(address) {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('ff')) return true;
  if (normalized.startsWith('2001:db8:')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true;
  }

  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return false;
}

function parsePublicHttpUrl(rawUrl, options = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('URL 格式无效');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('只支持 HTTP 和 HTTPS 链接');
  }

  if (parsed.username || parsed.password) {
    throw new Error('不支持 URL 中携带用户名或密码');
  }

  if (!parsed.hostname) {
    throw new Error('URL 缺少域名');
  }

  if (!options.allowPrivateNetwork && (parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost') || parsed.hostname.endsWith('.local'))) {
    throw new Error('不允许访问本机或局域网地址');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!options.allowPrivateNetwork && net.isIP(hostname) && isPrivateAddress(hostname)) {
    throw new Error('不允许访问私有或保留 IP 地址');
  }

  return parsed;
}

async function assertPublicHostname(rawUrl, options = {}) {
  const parsed = parsePublicHttpUrl(rawUrl, options);
  if (options.allowPrivateNetwork) return parsed;

  let addresses;
  const cached = dnsCache.get(parsed.hostname);
  if (cached && cached.expiresAt > Date.now()) {
    addresses = cached.addresses;
  } else {
    try {
      addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
      dnsCache.set(parsed.hostname, {
        addresses,
        expiresAt: Date.now() + (options.dnsCacheTtlMs || DNS_CACHE_TTL_MS),
      });
    } catch {
      throw new Error('域名无法解析');
    }
  }

  if (!addresses.length) throw new Error('域名没有可用 IP 地址');
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('域名解析到了私有或保留 IP 地址');
  }

  return parsed;
}

module.exports = {
  assertPublicHostname,
  isPrivateAddress,
  isPrivateIPv4,
  isPrivateIPv6,
  parsePublicHttpUrl,
};
