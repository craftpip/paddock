const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:5050/ws/messaging/pad-openclaw-love');
let n = 0;
ws.on('open', () => {
  console.log('OPEN');
  ws.send(JSON.stringify({ type: 'run', cmd: 'openclaw channels add --channel telegram --token \'<BOT_TOKEN>\'' }));
});
ws.on('message', (d) => {
  n++;
  const s = String(d).slice(0, 200);
  console.log('MSG', n, JSON.stringify(s));
});
ws.on('close', (c, r) => console.log('CLOSE', c, String(r)));
ws.on('error', (e) => console.log('ERROR', e.message));
setTimeout(() => { console.log('total', n); process.exit(0); }, 15000);
