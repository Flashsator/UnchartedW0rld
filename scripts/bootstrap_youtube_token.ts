import http from 'node:http';
import { URL } from 'node:url';
import 'dotenv/config';
import { google } from 'googleapis';

const CLIENT_ID = process.env.YT_CLIENT_ID;
const CLIENT_SECRET = process.env.YT_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:8765/oauth';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('YT_CLIENT_ID and YT_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

const oauth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const authUrl = oauth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube',
    // Lets uploadCaption() insert a real selectable caption track via
    // captions.insert (otherwise it 403s and the burned-in SRT is the only copy).
    'https://www.googleapis.com/auth/youtube.force-ssl',
    // Powers the analytics feedback loop (fetchTopPerformingTitles): ranks past
    // videos by CTR/retention so the Outro "Watch next" card + title hints work.
    'https://www.googleapis.com/auth/yt-analytics.readonly',
  ],
});

console.log('\nOpen this URL in your browser, sign in to the channel you want to publish to:\n');
console.log(authUrl);
console.log('\nWaiting for callback on http://localhost:8765 ...\n');

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/oauth')) {
    res.writeHead(404).end();
    return;
  }
  const u = new URL(req.url, 'http://localhost:8765');
  const code = u.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('Missing code');
    return;
  }
  try {
    const { tokens } = await oauth.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK. Refresh token printed in terminal. You can close this tab.');

    console.log('\n=== COPY THIS INTO YOUR .env ===\n');
    console.log(`YT_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\n(Store as a GitHub Secret too — never commit.)\n');
    server.close();
  } catch (e) {
    res.writeHead(500).end((e as Error).message);
  }
});

server.listen(8765);
