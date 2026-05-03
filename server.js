const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3002;

const NEWS_FEED_URL = 'https://news.google.com/rss?hl=en-AU&gl=AU&ceid=AU:en';
const NEWS_CACHE_MS = 10 * 60 * 1000;
const NEWS_FETCH_TIMEOUT_MS = 8000;
const NEWS_MAX_ITEMS = 15;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

let newsCache = { ts: 0, body: null };

function fetchUrl(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'thorleypark-home/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchUrl(next, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(NEWS_FETCH_TIMEOUT_MS, () => req.destroy(new Error('Request timeout')));
  });
}

function stripCdata(s) {
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : s;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function clean(s) {
  return decodeEntities(stripCdata(s)).replace(/\s+/g, ' ').trim();
}

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null && items.length < NEWS_MAX_ITEMS) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1];
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [, ''])[1];
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [, ''])[1];
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [, ''])[1];
    const cleanTitle = clean(title);
    const cleanLink = clean(link);
    if (!cleanTitle || !cleanLink) continue;
    items.push({
      title: cleanTitle,
      link: cleanLink,
      pubDate: clean(pubDate),
      source: clean(source),
    });
  }
  return items;
}

async function getNews() {
  const now = Date.now();
  if (newsCache.body && (now - newsCache.ts) < NEWS_CACHE_MS) {
    return newsCache.body;
  }
  const xml = await fetchUrl(NEWS_FEED_URL);
  const items = parseRssItems(xml);
  if (!items.length) throw new Error('No items parsed from feed');
  const body = JSON.stringify({
    updated: new Date().toISOString(),
    source: 'Google News (AU)',
    items,
  });
  newsCache = { ts: now, body };
  return body;
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/news') {
    try {
      const body = await getNews();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(body);
    } catch (e) {
      res.writeHead(502, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(JSON.stringify({ error: 'Failed to fetch news', detail: String(e.message || e) }));
    }
  }

  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath.split('?')[0]);

  // Security: no directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=300';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cacheControl });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Thorley Park Home running on http://localhost:${PORT}`);
});
