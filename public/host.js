const $ = (id) => document.getElementById(id);
const PHASES = {
  idle: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  retrying: '重连中…',
  stopped: '已停止',
};

let lastPhase = '';
let booted = false;
let voiceEnabled = true;

function render(state) {
  const live = state.live || {};
  const phase = PHASES[live.phase] ?? live.phase ?? '—';
  $('phase').textContent = phase;
  $('title').textContent = live.title || '—';
  const roomStatus = live.status === 2 ? '直播中' : live.status === 4 ? '未开播' : live.status ? `状态 ${live.status}` : '—';
  $('roomStatus').textContent = roomStatus;
  $('messages').textContent = String(live.messages ?? 0);
  $('chats').textContent = String(live.chats ?? 0);
  $('clients').textContent = state.clients > 0 ? `已连接 ${state.clients}` : '未连接';
  if (live.lastError) {
    $('error').textContent = live.lastError;
    $('error').classList.add('bad');
  }
  $('dot').classList.toggle('on', live.phase === 'connected');
  $('pillText').textContent = live.phase === 'connected' ? '弹幕已连接' : phase;
  voiceEnabled = state.voice !== false;
  $('voiceBtn').textContent = `语音播报：${voiceEnabled ? '开' : '关'}`;
  $('voiceBtn').style.opacity = voiceEnabled ? '1' : '0.55';

  if (!booted || lastPhase !== live.phase) {
    if (live.phase === 'connected') {
      showToast('弹幕已连接，直播画面可以开播了');
    }
    booted = true;
    lastPhase = live.phase;
  }

  if (document.activeElement !== $('roomInput') && state.roomId) {
    $('roomInput').value = state.roomId;
  }
}

let toastTimer = null;
function showToast(text, kind = 'info') {
  $('error').textContent = text;
  $('error').classList.toggle('bad', kind === 'bad');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('error').textContent = '';
    $('error').classList.remove('bad');
  }, 4000);
}

async function refresh() {
  try {
    const res = await fetch('/api/state');
    render(await res.json());
  } catch {
    $('dot').classList.remove('on');
    $('pillText').textContent = '服务未运行';
  }
}

$('connectBtn').addEventListener('click', async () => {
  const roomId = $('roomInput').value.trim();
  if (!roomId) {
    showToast('请先填直播间号', 'bad');
    return;
  }
  $('connectBtn').disabled = true;
  try {
    const res = await fetch('/api/room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId }),
    });
    if (!res.ok) throw new Error('连接请求失败');
    await refresh();
    showToast('正在连接直播间…');
  } catch (err) {
    showToast(err.message, 'bad');
  } finally {
    $('connectBtn').disabled = false;
  }
});

$('disconnectBtn').addEventListener('click', async () => {
  await fetch('/api/room', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: '' }),
  });
  $('roomInput').value = '';
  await refresh();
});

$('overlayBtn').addEventListener('click', () => {
  window.open('/overlay', '_blank');
});

$('voiceBtn').addEventListener('click', async () => {
  const next = !voiceEnabled;
  try {
    const res = await fetch('/api/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok) throw new Error('切换失败');
    voiceEnabled = next;
    $('voiceBtn').textContent = `语音播报：${next ? '开' : '关'}`;
    $('voiceBtn').style.opacity = next ? '1' : '0.55';
    showToast(next ? '语音播报已开启' : '语音播报已关闭');
  } catch (err) {
    showToast(err.message, 'bad');
  }
});

$('simBtn').addEventListener('click', async () => {
  const content = $('simText').value.trim() || '加入';
  const nickname = $('simNick').value.trim() || '测试观众';
  await fetch('/api/dev/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'chat', nickname, content, uid: `sim-${nickname}` }),
  });
  showToast(`已模拟「${nickname}」发 ${content}`);
});

document.querySelectorAll('.quick button').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('simText').value = btn.dataset.cmd;
    $('simBtn').click();
  });
});

$('simText').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('simBtn').click();
});

$('roomInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('connectBtn').click();
});

$('overlayUrl').textContent = `${location.origin}/overlay`;
refresh();
setInterval(refresh, 2000);
