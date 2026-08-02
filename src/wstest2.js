const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:5050/ws/messaging/pad-openclaw-love');
let n = 0;
ws.on('open', () => {
  console.log('OPEN, readyState', ws.readyState);
  setTimeout(() => {
    console.log('sending, readyState', ws.readyState, 'bufferedAmount', ws.bufferedAmount);
    ws.send(JSON.stringify({ type: 'run', cmd: 'echo hi-from-ws-test' }));
    console.log('sent, bufferedAmount', ws.bufferedAmount);
  }, 500);
});
ws.on('message', (d) => {
  n++;
  console.log('MSG', n, JSON.stringify(String(d).slice(0,200)));
});
ws.on('close', (c, r) => console.log('CLOSE', c, String(r)));
ws.on('error', (e) => console.log('ERROR', e.message));
setTimeout(() => { console.log('total', n, 'readyState', ws.readyState); process.exit(0); }, 12000);
