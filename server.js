const express = require('express');
const https = require('https');
const querystring = require('querystring');
const crypto = require('crypto');
const app = express();
app.use(express.json());

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'http://localhost:8080';
const REDIRECT_URI = BASE_URL + '/callback';

// Sessões em memória: { sessionId -> { accessToken, refreshToken, tokenExpiry } }
const sessions = {};

function getSession(req) {
  const sid = parseCookie(req.headers.cookie || '')['sid'];
  return sid && sessions[sid] ? { sid, ...sessions[sid] } : null;
}

function parseCookie(str) {
  return str.split(';').reduce((acc, part) => {
    const [k, ...v] = part.trim().split('=');
    if (k) acc[k.trim()] = decodeURIComponent(v.join('='));
    return acc;
  }, {});
}

app.get('/login', (req, res) => {
  const params = querystring.stringify({
    response_type: 'code', client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI, state: 'painel'
  });
  res.redirect('https://www.bling.com.br/Api/v3/oauth/authorize?' + params);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('Erro: codigo nao recebido');
  try {
    const token = await fetchToken('authorization_code', { code, redirect_uri: REDIRECT_URI });
    const sid = crypto.randomBytes(24).toString('hex');
    sessions[sid] = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenExpiry: Date.now() + (token.expires_in * 1000)
    };
    // Cookie dura 6 horas (tempo do access token do Bling)
    res.setHeader('Set-Cookie', 'sid=' + sid + '; HttpOnly; SameSite=Lax; Max-Age=21600; Path=/');
    res.redirect('/');
  } catch (err) { res.send('Erro ao obter token: ' + err.message); }
});

async function ensureToken(req) {
  const sess = getSession(req);
  if (!sess) throw new Error('Nao autenticado');
  if (Date.now() > sess.tokenExpiry - 60000) {
    const token = await fetchToken('refresh_token', { refresh_token: sess.refreshToken });
    sessions[sess.sid].accessToken = token.access_token;
    sessions[sess.sid].refreshToken = token.refresh_token || sess.refreshToken;
    sessions[sess.sid].tokenExpiry = Date.now() + (token.expires_in * 1000);
    return sessions[sess.sid].accessToken;
  }
  return sess.accessToken;
}

function fetchToken(grantType, params) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify(Object.assign({ grant_type: grantType, redirect_uri: REDIRECT_URI }, params));
    const credentials = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
    const options = {
      hostname: 'www.bling.com.br', path: '/Api/v3/oauth/token', method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Basic ' + credentials,
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (response) => {
      let data = '';
      response.on('data', c => data += c);
      response.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(JSON.stringify(json)));
          else resolve(json);
        } catch(e) { reject(new Error('Resposta invalida: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.get('/auth/status', (req, res) => {
  const sess = getSession(req);
  res.json({ authenticated: !!(sess && Date.now() < sess.tokenExpiry) });
});

// Debug: busca múltiplos pedidos — /debug/pedidos/id1,id2,id3
app.get('/debug/pedidos/:ids', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }
  const ids = req.params.ids.split(',').slice(0, 5);
  const results = await Promise.all(ids.map(id => new Promise((resolve) => {
    const options = {
      hostname: 'www.bling.com.br',
      path: '/Api/v3/pedidos/vendas/' + id.trim(),
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    };
    const request = require('https').request(options, (response) => {
      let data = '';
      response.on('data', c => data += c);
      response.on('end', () => {
        try {
          const d = JSON.parse(data).data || {};
          resolve({ id: d.id, numero: d.numero, data: d.data, situacao: d.situacao });
        } catch(e) { resolve({ id, error: data.slice(0,100) }); }
      });
    });
    request.on('error', err => resolve({ id, error: err.message }));
    request.end();
  })));
  res.json(results);
});

// Debug: retorna resposta RAW completa do pedido
app.get('/debug/pedido/:id', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }
  const options = {
    hostname: 'www.bling.com.br',
    path: '/Api/v3/pedidos/vendas/' + req.params.id,
    method: 'GET',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  };
  const request = require('https').request(options, (response) => {
    let data = '';
    response.on('data', c => data += c);
    response.on('end', () => {
      try { res.json(JSON.parse(data)); }
      catch(e) { res.json({ raw: data }); }
    });
  });
  request.on('error', err => res.status(500).json({ error: err.message }));
  request.end();
});

app.get('/logout', (req, res) => {
  const sid = parseCookie(req.headers.cookie || '')['sid'];
  if (sid) delete sessions[sid];
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Max-Age=0; Path=/');
  res.redirect('/');
});

// Proxy para a API do Bling — token por sessão
app.use('/api/bling', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }

  const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const blingPath = '/Api/v3' + req.path + qs;
  console.log('[PROXY]', req.method, blingPath);

  const options = {
    hostname: 'www.bling.com.br',
    path: blingPath,
    method: req.method,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  };

  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', c => data += c);
    response.on('end', () => {
      console.log('[PROXY] status:', response.statusCode, '| bytes:', data.length);
      try { res.status(response.statusCode).json(JSON.parse(data)); }
      catch(e) { res.status(500).json({ error: 'Resposta invalida', raw: data.slice(0, 200) }); }
    });
  });
  request.on('error', err => res.status(500).json({ error: err.message }));
  request.end();
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(__dirname + '/index.html');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Painel rodando na porta ' + PORT));
