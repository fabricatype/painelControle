const express = require('express');
const https = require('https');
const querystring = require('querystring');
const app = express();
app.use(express.json());

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'http://localhost:8080';
const REDIRECT_URI = BASE_URL + '/callback';

let accessToken = null;
let refreshToken = null;
let tokenExpiry = null;

app.get('/login', (req, res) => {
  const params = querystring.stringify({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state: 'painel' });
  res.redirect('https://www.bling.com.br/Api/v3/oauth/authorize?' + params);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('Erro: codigo nao recebido');
  try {
    const token = await fetchToken('authorization_code', { code: code, redirect_uri: REDIRECT_URI });
    accessToken = token.access_token;
    refreshToken = token.refresh_token;
    tokenExpiry = Date.now() + (token.expires_in * 1000);
    res.redirect('/');
  } catch (err) { res.send('Erro ao obter token: ' + err.message); }
});

async function ensureToken() {
  if (!accessToken) throw new Error('Nao autenticado');
  if (Date.now() > tokenExpiry - 60000) {
    const token = await fetchToken('refresh_token', { refresh_token: refreshToken });
    accessToken = token.access_token;
    refreshToken = token.refresh_token || refreshToken;
    tokenExpiry = Date.now() + (token.expires_in * 1000);
  }
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
      response.on('data', function(chunk) { data += chunk; });
      response.on('end', function() {
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
  res.json({ authenticated: !!accessToken && Date.now() < tokenExpiry });
});

app.use('/api/bling', async (req, res) => {
  try { await ensureToken(); } catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }
  const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const options = {
    hostname: 'www.bling.com.br',
    path: '/Api/v3' + req.path + qs,
    method: req.method,
    headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' }
  };
  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', function(chunk) { data += chunk; });
    response.on('end', function() {
      try { res.status(response.statusCode).json(JSON.parse(data)); }
      catch(e) { res.status(500).json({ error: 'Resposta invalida' }); }
    });
  });
  request.on('error', function(err) { res.status(500).json({ error: err.message }); });
  request.end();
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(__dirname + '/index.html');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Painel rodando na porta ' + PORT));
