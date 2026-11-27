import { $, tg } from './ui.js';

const params = new URLSearchParams(location.search);

let ws = null;
let spectate = params.get('spectate') === '1';
let roomId = params.get('room') || tg?.initDataUnsafe?.start_param || null;
let reconnectDelay = 500;

export function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function hello() {
  send({
    type: 'hello',
    initData: tg?.initData || '',
    room: roomId,
    spectate,
    dev_uid: params.get('dev_uid'),
    dev_name: params.get('dev_name'),
  });
}

export function connect(onMessage, onConnect) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    reconnectDelay = 500;
    onConnect();
    $('conn').classList.add('hidden');
    hello();
  };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    $('conn').classList.remove('hidden');
    setTimeout(() => connect(onMessage, onConnect), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  };
}

export function confirmRoom(id) {
  roomId = id;
}

export function selectRoom(id, asSpectator) {
  roomId = id;
  spectate = asSpectator;
  hello();
}
