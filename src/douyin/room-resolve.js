const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

const ENTER_PARAMS = {
  aid: '6383',
  app_name: 'douyin_web',
  live_id: '1',
  device_platform: 'web',
  language: 'zh-CN',
  enter_from: 'web_live',
  cookie_enabled: 'true',
  screen_width: '1920',
  screen_height: '1080',
  browser_language: 'zh-CN',
  browser_platform: 'Win32',
  browser_name: 'Chrome',
  browser_version: '134.0.0.0',
};

export function parseWebRoomInput(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  const fromUrl = /live\.douyin\.com\/([A-Za-z0-9_-]+)/i.exec(s);
  if (fromUrl) return fromUrl[1];
  if (/^\d{5,}$/.test(s)) return s;
  return null;
}

function splitSetCookie(headers) {
  return headers.getSetCookie?.() ?? [];
}

function mergeCookies(...chunks) {
  const map = new Map();
  for (const chunk of chunks) {
    for (const part of String(chunk).split(';')) {
      const kv = part.trim();
      const i = kv.indexOf('=');
      if (i > 0) map.set(kv.slice(0, i), kv.slice(i + 1));
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

export async function resolveDouyinRoom(input) {
  const webRoomId = parseWebRoomInput(input);
  if (!webRoomId) {
    throw new Error('直播间号无效，请填 live.douyin.com/ 后面那串数字');
  }

  const home = await fetch('https://live.douyin.com/', {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  const homeCookies = splitSetCookie(home.headers)
    .map((c) => c.split(';')[0])
    .join('; ');

  const url = new URL('https://live.douyin.com/webcast/room/web/enter/');
  for (const [k, v] of Object.entries({ ...ENTER_PARAMS, web_rid: webRoomId })) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Cookie: homeCookies,
      Referer: `https://live.douyin.com/${webRoomId}`,
    },
  });
  if (!res.ok) throw new Error(`解析直播间失败 HTTP ${res.status}`);

  const body = await res.json();
  if (body.status_code && body.status_code !== 0) {
    const prompt = body.data?.prompts;
    throw new Error(
      `抖音返回 status_code=${body.status_code}${prompt ? `（${prompt}）` : ''}，请确认直播间号正确且正在直播`,
    );
  }

  const room = body.data?.data?.[0] ?? body.data?.room;
  const roomId = room?.id_str ? String(room.id_str) : '';
  if (!roomId) {
    throw new Error('未解析到内部房间号，请确认直播间正在直播');
  }

  const cookie = mergeCookies(
    homeCookies,
    splitSetCookie(res.headers)
      .map((c) => c.split(';')[0])
      .join('; '),
  );

  return {
    webRoomId,
    roomId,
    status: room.status ?? null,
    title: room.title ?? null,
    nickname: room.owner?.nickname ?? null,
    cookie,
  };
}
