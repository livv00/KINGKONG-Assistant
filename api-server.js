/**
 * 内置音乐搜索 API 服务器
 * 随 Electron 应用自动启动，提供 /search 和 /musicUrl 接口
 * 默认端口: 3100
 */
const http = require('http');
const https = require('https');
const url = require('url');

const PORT = 3100;

// 平台映射
const PLATFORMS = {
  kw: '酷我',
  kg: '酷狗',
  wy: '网易',
  tx: 'QQ',
  mg: '咪咕'
};

/**
 * 网易云音乐搜索
 */
function searchNetease(keyword, page, limit) {
  return new Promise((resolve, reject) => {
    const offset = (page - 1) * limit;
    const postData = `s=${encodeURIComponent(keyword)}&type=1&offset=${offset}&limit=${limit}`;
    const options = {
      hostname: 'music.163.com',
      path: '/api/search/get',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Referer': 'https://music.163.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code !== 200) {
            reject(new Error('网易云搜索失败: code=' + json.code));
            return;
          }
          const songs = (json.result && json.result.songs) || [];
          const list = songs.map(song => ({
            name: song.name || '',
            singer: (song.artists || []).map(a => a.name).join(' / '),
            album: (song.album && song.album.name) || '',
            duration: Math.floor((song.duration || 0) / 1000),
            interval: formatDuration(Math.floor((song.duration || 0) / 1000)),
            img: (song.album && song.album.picUrl) ? song.album.picUrl + '?param=60x60' : '',
            hash: String(song.id),
            songmid: String(song.id),
            quality: {
              '128k': { size: '' },
              '320k': { size: '' }
            }
          }));
          resolve({
            source: 'wy',
            list: list,
            total: (json.result && json.result.songCount) || list.length,
            limit: limit,
            page: page
          });
        } catch (e) {
          reject(new Error('解析网易云搜索结果失败: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Listen1 网易云音乐搜索（备用音源）- 使用 /api/search/pc
 * 当洛雪的 searchNetease 失败时自动降级到此实现
 */
function searchNeteaseListen1(keyword, page, limit) {
  return new Promise((resolve, reject) => {
    const offset = (page - 1) * limit;
    const postData = `s=${encodeURIComponent(keyword)}&type=1&offset=${offset}&limit=${limit}`;
    const options = {
      hostname: 'music.163.com',
      path: '/api/search/pc',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Referer': 'https://music.163.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code !== 200) {
            reject(new Error('Listen1 网易云搜索失败: code=' + json.code));
            return;
          }
          const songs = (json.result && json.result.songs) || [];
          const list = songs.map(song => ({
            name: song.name || '',
            singer: (song.artists || []).map(a => a.name).join(' / '),
            album: (song.album && song.album.name) || '',
            duration: Math.floor((song.duration || 0) / 1000),
            interval: formatDuration(Math.floor((song.duration || 0) / 1000)),
            img: (song.album && song.album.picUrl) ? song.album.picUrl + '?param=60x60' : '',
            hash: String(song.id),
            songmid: String(song.id),
            quality: {
              '128k': { size: '' },
              '320k': { size: '' }
            }
          }));
          resolve({
            source: 'wy',
            list: list,
            total: (json.result && json.result.songCount) || list.length,
            limit: limit,
            page: page
          });
        } catch (e) {
          reject(new Error('Listen1 网易云解析失败: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * 获取网易云音乐直链
 */
function getNeteaseUrl(songId, quality) {
  return new Promise((resolve, reject) => {
    // 方案1: 使用 outer/url 接口跟随重定向获取直链
    const path = `/song/media/outer/url?id=${songId}.mp3`;
    const options = {
      hostname: 'music.163.com',
      path: path,
      method: 'GET',
      headers: {
        'Referer': 'https://music.163.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };

    const req = https.request(options, (res) => {
      // 301/302 重定向，获取 Location
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (location) {
          // 直接返回重定向地址，代理服务器会处理
          resolve(location);
        } else {
          getNeteaseUrlApi(songId, quality).then(resolve).catch(reject);
        }
        return;
      }
      // 403/404 等，尝试方案2
      getNeteaseUrlApi(songId, quality).then(resolve).catch(reject);
    });
    req.on('error', () => {
      getNeteaseUrlApi(songId, quality).then(resolve).catch(reject);
    });
    req.end();
  });
}

/**
 * 网易云音乐直链 - 方案2: 使用 player/url API
 */
function getNeteaseUrlApi(songId, quality) {
  return new Promise((resolve, reject) => {
    const br = quality === 'flac' ? 999000 : (quality === '320k' ? 320000 : 128000);
    const postData = `ids=[${songId}]&br=${br}`;
    const options = {
      hostname: 'music.163.com',
      path: '/api/song/enhance/player/url',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Referer': 'https://music.163.com',
        'Cookie': 'MUSIC_U=00',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 200 && json.data && json.data.length > 0) {
            const url = json.data[0].url;
            if (url) {
              let finalUrl = url;
              if (finalUrl.startsWith('http://')) {
                finalUrl = 'https://' + finalUrl.substring(7);
              }
              resolve(finalUrl);
            } else {
              reject(new Error('该歌曲暂时无法播放（可能需要VIP）'));
            }
          } else {
            reject(new Error('获取直链失败: code=' + json.code));
          }
        } catch (e) {
          reject(new Error('解析直链失败: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * 酷我音乐搜索 - 使用移动端 API
 */
function searchKuwo(keyword, page, limit) {
  return new Promise((resolve, reject) => {
    const path = `/newh5/singles/songsearch?key=${encodeURIComponent(keyword)}&pn=${page}&rn=${limit}&httpsStatus=1&reqfrom=mbox`;
    const options = {
      hostname: 'm.kuwo.cn',
      path: path,
      method: 'GET',
      headers: {
        'Referer': 'https://m.kuwo.cn/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code !== 200 && json.status !== 'ok') {
            reject(new Error('酷我搜索失败: ' + (json.msg || json.message || 'code=' + json.code)));
            return;
          }
          const records = (json.data && json.data.list) || (json.data && json.data.musicList) || [];
          const list = records.map(song => ({
            name: song.name || song.song || '',
            singer: song.artist || song.singer || '',
            album: song.album || '',
            duration: Math.floor((song.duration || song.songTime || 0) / 1000),
            interval: formatDuration(Math.floor((song.duration || song.songTime || 0) / 1000)),
            img: song.pic || song.albumpic || (song.musicrid ? 'https://img1.kuwo.cn/star/albumcover/' : ''),
            hash: String(song.rid || song.musicrid || song.id || ''),
            songmid: String(song.rid || song.musicrid || song.id || ''),
            quality: {
              '128k': { size: '' },
              '320k': { size: '' }
            }
          }));
          resolve({
            source: 'kw',
            list: list,
            total: (json.data && (json.data.total || json.data.num)) || list.length,
            limit: limit,
            page: page
          });
        } catch (e) {
          reject(new Error('解析酷我搜索结果失败: ' + e.message + ' (返回内容前100字符: ' + data.substring(0, 100) + ')'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 获取酷我音乐直链
 */
function getKuwoUrl(rid, quality) {
  return new Promise((resolve, reject) => {
    const format = quality === 'flac' ? 'flac' : (quality === '320k' ? '320kmp3' : '128kmp3');
    const br = quality === 'flac' ? '2000kflac' : (quality === '320k' ? '320kmp3' : '128kmp3');
    const apiPath = `/url?format=${format}&rid=${rid}&response=url&type=convert_url&br=${br}&httpsStatus=1`;

    // 方案1: 移动端 API（无需 cookie）
    const options = {
      hostname: 'm.kuwo.cn',
      path: apiPath,
      method: 'GET',
      headers: {
        'Referer': 'https://m.kuwo.cn/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // 直接返回 URL
        if (data.startsWith('http')) {
          resolve(data.trim());
          return;
        }
        try {
          const json = JSON.parse(data);
          if (json.url) {
            resolve(json.url);
          } else if (json.data && json.data.url) {
            resolve(json.data.url);
          } else {
            // 方案2: 尝试 www.kuwo.cn
            getKuwoUrlWeb(rid, quality).then(resolve).catch(() => {
              reject(new Error('酷我获取直链失败: ' + (json.msg || data.substring(0, 100))));
            });
          }
        } catch (e) {
          // 方案2: 尝试 www.kuwo.cn
          getKuwoUrlWeb(rid, quality).then(resolve).catch(() => {
            reject(new Error('酷我解析直链失败: ' + data.substring(0, 100)));
          });
        }
      });
    });
    req.on('error', () => {
      // 方案2: 尝试 www.kuwo.cn
      getKuwoUrlWeb(rid, quality).then(resolve).catch(reject);
    });
    req.end();
  });
}

/**
 * 酷我直链 - 方案2: www.kuwo.cn
 */
function getKuwoUrlWeb(rid, quality) {
  return new Promise((resolve, reject) => {
    const format = quality === 'flac' ? 'flac' : (quality === '320k' ? '320kmp3' : '128kmp3');
    const br = quality === 'flac' ? '2000kflac' : (quality === '320k' ? '320kmp3' : '128kmp3');
    const path = `/url?format=${format}&rid=${rid}&response=url&type=convert_url&br=${br}&httpsStatus=1`;
    const options = {
      hostname: 'www.kuwo.cn',
      path: path,
      method: 'GET',
      headers: {
        'Referer': 'https://www.kuwo.cn/',
        'csrf': 'xxxx',
        'Cookie': 'kw_token=xxxx',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (data.startsWith('http')) {
          resolve(data.trim());
        } else {
          try {
            const json = JSON.parse(data);
            if (json.url) {
              resolve(json.url);
            } else {
              reject(new Error('酷我Web获取直链失败'));
            }
          } catch (e) {
            reject(new Error('酷我Web解析直链失败'));
          }
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00';
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

// ===== 酷狗音乐 =====
function searchKugou(keyword, page, limit) {
  return new Promise((resolve, reject) => {
    const path = `/api/v3/search/song?keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${limit}&showtype=10`;
    const options = {
      hostname: 'mobilecdn.kugou.com',
      path: path,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' }
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status !== 1) { reject(new Error('酷狗搜索失败')); return; }
          const records = (json.data && json.data.info) || [];
          const list = records.map(song => ({
            name: song.songname || '',
            singer: song.singername || '',
            album: song.album_name || '',
            duration: Math.floor((song.duration || 0)),
            interval: formatDuration(Math.floor(song.duration || 0)),
            img: song.album_img ? song.album_img.replace('{size}', '150') : '',
            hash: song.hash || '',
            songmid: song.hash || '',
            quality: { '128k': {}, '320k': {} }
          }));
          resolve({ source: 'kg', list, total: (json.data && json.data.total) || list.length, limit, page });
        } catch (e) { reject(new Error('酷狗解析失败: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

function getKugouUrl(hash, quality) {
  return new Promise((resolve, reject) => {
    // 先获取 album_id
    const infoPath = `/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`;
    https.get('mobiles.kugou.com', infoPath, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let albumId = '';
        try { albumId = JSON.parse(data).album_id || ''; } catch (e) {}
        const fmt = quality === 'flac' ? 'flac' : (quality === '320k' ? 'mp3' : 'mp3');
        const urlPath = `/url?format=${fmt}&hash=${hash}&album_id=${albumId}&br=${quality === 'flac' ? 1411 : (quality === '320k' ? 320 : 128)}000`;
        https.get('wwwapi.kugou.com', urlPath, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.kugou.com/' } }, (res2) => {
          let d2 = '';
          res2.on('data', chunk => d2 += chunk);
          res2.on('end', () => {
            try {
              const json = JSON.parse(d2);
              const url = json.data && json.data.url;
              if (url) resolve(url.startsWith('http://') ? url.replace('http://', 'https://') : url);
              else reject(new Error('酷狗获取直链失败'));
            } catch (e) { reject(new Error('酷狗解析直链失败')); }
          });
        }).on('error', reject);
      });
    }).on('error', reject);
  });
}

// ===== QQ音乐 =====
function searchQQ(keyword, page, limit) {
  return new Promise((resolve, reject) => {
    const path = `/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(keyword)}&format=json&p=${page}&n=${limit}&cr=1&g_tk=5381`;
    const options = {
      hostname: 'c.y.qq.com',
      path: path,
      method: 'GET',
      headers: { 'Referer': 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' }
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code !== 0) { reject(new Error('QQ音乐搜索失败')); return; }
          const songs = (json.data && json.data.song && json.data.song.list) || [];
          const list = songs.map(song => ({
            name: song.songname || '',
            singer: (song.singer || []).map(s => s.name).join(' / '),
            album: song.albumname || '',
            duration: song.interval || 0,
            interval: formatDuration(song.interval || 0),
            img: song.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.albummid}.jpg` : '',
            hash: song.songmid || '',
            songmid: song.songmid || '',
            quality: { '128k': {}, '320k': {} }
          }));
          resolve({ source: 'tx', list, total: (json.data && json.data.song && json.data.song.total) || list.length, limit, page });
        } catch (e) { reject(new Error('QQ音乐解析失败: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

function getQQUrl(songmid, quality) {
  return new Promise((resolve, reject) => {
    const guid = Math.floor(Math.random() * 1e10);
    const format = quality === 'flac' ? 'F' : (quality === '320k' ? 'M' : 'C');
    // 先获取 vkey
    const vkeyPath = `/base/fcgi-bin/fcg_music_express_mobile3.fcg?format=json205361747&guid=${guid}&songmid=${songmid}&filename=C400${songmid}.${format === 'F' ? 'flac' : 'm4a'}`;
    const options = {
      hostname: 'u.y.qq.com',
      path: vkeyPath,
      method: 'GET',
      headers: { 'Referer': 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' }
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const items = json.data && json.data.items;
          if (items && items.length > 0 && items[0].vkey) {
            const filename = items[0].filename;
            const url = `https://dl.stream.qqmusic.qq.com/${filename}?vkey=${items[0].vkey}&guid=${guid}&fromtag=46`;
            resolve(url);
          } else {
            reject(new Error('QQ音乐获取直链失败（可能需要VIP）'));
          }
        } catch (e) { reject(new Error('QQ音乐解析直链失败')); }
      });
    }).on('error', reject);
  });
}

// ===== 咪咕音乐 =====
function searchMigu(keyword, page, limit) {
  return new Promise((resolve, reject) => {
    const path = `/v1.0/content/search_all.do?&isCopyright=0&pageSize=${limit}&pageNo=${page}&searchSwitch={%22song\":1,\"album\":0,\"mv\":0,\"lyric\":0,\"singer\":0}&text=${encodeURIComponent(keyword)}`;
    const options = {
      hostname: 'm.music.migu.cn',
      path: path,
      method: 'GET',
      headers: { 'Referer': 'https://m.music.migu.cn/', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0)' }
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code !== '000000') { reject(new Error('咪咕搜索失败')); return; }
          const records = (json.songResultData && json.songResultData.result) || [];
          const list = records.map(song => ({
            name: song.name || '',
            singer: (song.artists || []).map(a => a.name).join(' / '),
            album: (song.albums && song.albums[0] && song.albums[0].name) || '',
            duration: 0,
            interval: '',
            img: song.albums && song.albums[0] ? song.albums[0].albumPicM : '',
            hash: song.copyrightId || song.contentId || '',
            songmid: song.copyrightId || song.contentId || '',
            quality: { '128k': {}, '320k': {} }
          }));
          resolve({ source: 'mg', list, total: (json.songResultData && json.songResultData.totalCount) || list.length, limit, page });
        } catch (e) { reject(new Error('咪咕解析失败: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

function getMiguUrl(id, quality) {
  return new Promise((resolve, reject) => {
    const format = quality === 'flac' ? 'SQ' : (quality === '320k' ? 'HQ' : 'PQ');
    const path = `/v1.0/content/listen-url?copyrightId=${id}&type=${format}`;
    const options = {
      hostname: 'm.music.migu.cn',
      path: path,
      method: 'GET',
      headers: { 'Referer': 'https://m.music.migu.cn/', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0)' }
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === '000000' && json.data && json.data.url) {
            resolve(json.data.url);
          } else {
            reject(new Error('咪咕获取直链失败'));
          }
        } catch (e) { reject(new Error('咪咕解析直链失败')); }
      });
    }).on('error', reject);
  });
}

// ===== 多平台降级搜索 =====
const SEARCH_FUNCTIONS = { kw: searchKuwo, kg: searchKugou, wy: searchNetease, tx: searchQQ, mg: searchMigu };
const URL_FUNCTIONS = { kw: getKuwoUrl, kg: getKugouUrl, wy: getNeteaseUrl, tx: getQQUrl, mg: getMiguUrl };

// Listen1 备用音源映射（洛雪失败后同平台降级）
const LISTEN1_SEARCH = { wy: searchNeteaseListen1 };

// 降级顺序：当前平台 → 酷我 → 酷狗 → 网易 → QQ → 咪咕
function getFallbackOrder(source) {
  const order = ['kw', 'kg', 'wy', 'tx', 'mg'];
  return [source, ...order.filter(s => s !== source)];
}

// ===== HTTP 服务器 =====
function createApiServer() {
  const server = http.createServer((req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // 收集 POST body
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let postData = {};
      if (body) {
        try { postData = JSON.parse(body); } catch (e) { postData = {}; }
      }

      // 搜索接口 - 根据平台选择搜索源，支持多级降级
      if (pathname === '/search' && req.method === 'POST') {
        const { source = 'kw', keyword, page = 1, limit = 30 } = postData;
        if (!keyword) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 400, msg: '缺少 keyword 参数' }));
          return;
        }

        // 多级降级：洛雪当前平台 → Listen1 同平台 → 跨平台洛雪 → 跨平台 Listen1
        const fallbackOrder = getFallbackOrder(source);

        function trySearch(platformIdx) {
          if (platformIdx >= fallbackOrder.length) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 502, msg: '所有平台搜索失败' }));
            return;
          }
          const platform = fallbackOrder[platformIdx];
          const searchFn = SEARCH_FUNCTIONS[platform] || searchKuwo;
          searchFn(keyword, page, limit)
            .then(result => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ code: 200, data: result }));
            })
            .catch(err => {
              console.error(`[API] ${PLATFORMS[platform]}洛雪搜索失败:`, err.message);
              // 洛雪失败，尝试 Listen1 同平台
              const listen1Fn = LISTEN1_SEARCH[platform];
              if (listen1Fn) {
                listen1Fn(keyword, page, limit)
                  .then(result => {
                    console.log(`[API] ${PLATFORMS[platform]} Listen1 搜索成功（备用）`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ code: 200, data: result }));
                  })
                  .catch(err2 => {
                    console.error(`[API] ${PLATFORMS[platform]} Listen1 搜索也失败:`, err2.message);
                    trySearch(platformIdx + 1);
                  });
              } else {
                trySearch(platformIdx + 1);
              }
            });
        }
        trySearch(0);
        return;
      }

      // 获取直链接口 - 根据平台选择
      if (pathname === '/musicUrl' && req.method === 'POST') {
        const { source = 'kw', musicInfo = {}, type = '320k' } = postData;
        const id = musicInfo.hash || musicInfo.songmid;

        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 400, msg: '缺少 musicInfo.hash 或 songmid' }));
          return;
        }

        // 根据平台选择获取直链方式，带多平台降级
        const fallbackOrder = getFallbackOrder(source);
        const songName = musicInfo.name || '';
        const singer = musicInfo.singer || '';

        function tryGetUrl(platformIdx) {
          if (platformIdx >= fallbackOrder.length) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 502, msg: '所有平台均无法获取直链' }));
            return;
          }
          const platform = fallbackOrder[platformIdx];
          const getUrlFn = URL_FUNCTIONS[platform] || getKuwoUrl;
          // 非原始平台时，需要重新搜索获取该平台的ID
          if (platformIdx > 0 && songName) {
            const searchFn = SEARCH_FUNCTIONS[platform];
            searchFn(`${singer} ${songName}`, 1, 5)
              .then(searchResult => {
                if (searchResult.list && searchResult.list.length > 0) {
                  const matched = searchResult.list.find(s =>
                    s.name === songName && (!singer || s.singer.includes(singer))
                  ) || searchResult.list[0];
                  const newId = matched.hash || matched.songmid;
                  getUrlFn(newId, type)
                    .then(audioUrl => {
                      const proxyUrl = `http://localhost:${PORT}/stream?source=${platform}&id=${newId}&type=${type}`;
                      res.writeHead(200, { 'Content-Type': 'application/json' });
                      res.end(JSON.stringify({ code: 200, data: { url: proxyUrl, direct_url: audioUrl, platform } }));
                    })
                    .catch(() => tryGetUrl(platformIdx + 1));
                } else {
                  tryGetUrl(platformIdx + 1);
                }
              })
              .catch(() => tryGetUrl(platformIdx + 1));
          } else {
            getUrlFn(id, type)
              .then(audioUrl => {
                const proxyUrl = `http://localhost:${PORT}/stream?source=${platform}&id=${id}&type=${type}`;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ code: 200, data: { url: proxyUrl, direct_url: audioUrl, platform } }));
              })
              .catch(err => {
                console.error(`[API] ${PLATFORMS[platform]}获取直链失败:`, err.message);
                // 降级音质
                if (type !== '128k') {
                  getUrlFn(id, '128k')
                    .then(audioUrl => {
                      const proxyUrl = `http://localhost:${PORT}/stream?source=${platform}&id=${id}&type=128k`;
                      res.writeHead(200, { 'Content-Type': 'application/json' });
                      res.end(JSON.stringify({ code: 200, data: { url: proxyUrl, direct_url: audioUrl, platform } }));
                    })
                    .catch(() => tryGetUrl(platformIdx + 1));
                } else {
                  tryGetUrl(platformIdx + 1);
                }
              });
          }
        }
        tryGetUrl(0);
        return;
      }

      // 音频流代理 - 解决 CORS 和混合内容问题
      if (pathname === '/stream' && req.method === 'GET') {
        const { source = 'kw', id, type = '320k' } = parsedUrl.query;
        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 400, msg: '缺少 id 参数' }));
          return;
        }

        // 根据平台选择获取直链方式
        const getUrlFn = URL_FUNCTIONS[source] || getKuwoUrl;
        const REFERER_MAP = {
          wy: 'https://music.163.com',
          kw: 'https://www.kuwo.cn/',
          kg: 'https://www.kugou.com/',
          tx: 'https://y.qq.com/',
          mg: 'https://m.music.migu.cn/'
        };
        const referer = REFERER_MAP[source] || 'https://www.kuwo.cn/';
        getUrlFn(id, type)
          .then(audioUrl => {
            // 代理请求音频流
            const audioClient = audioUrl.startsWith('https') ? https : http;
            const proxyReq = audioClient.get(audioUrl, {
              headers: {
                'Referer': referer,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              }
            }, (audioRes) => {
              // 跟随重定向
              if (audioRes.statusCode === 301 || audioRes.statusCode === 302) {
                const redirectUrl = audioRes.headers.location;
                const redirectClient = redirectUrl.startsWith('https') ? https : http;
                redirectClient.get(redirectUrl, {
                  headers: {
                    'Referer': referer,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                  }
                }, (audioRes2) => {
                  res.writeHead(audioRes2.statusCode || 200, {
                    'Content-Type': audioRes2.headers['content-type'] || 'audio/mpeg',
                    'Content-Length': audioRes2.headers['content-length'] || '',
                    'Accept-Ranges': 'bytes'
                  });
                  audioRes2.pipe(res);
                }).on('error', () => {
                  res.writeHead(502);
                  res.end('Proxy error');
                });
                return;
              }
              res.writeHead(audioRes.statusCode || 200, {
                'Content-Type': audioRes.headers['content-type'] || 'audio/mpeg',
                'Content-Length': audioRes.headers['content-length'] || '',
                'Accept-Ranges': 'bytes'
              });
              audioRes.pipe(res);
            });
            proxyReq.on('error', () => {
              res.writeHead(502);
              res.end('Proxy error');
            });
          })
          .catch(err => {
            console.error('[API] 流代理失败:', err.message);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 502, msg: err.message }));
          });
        return;
      }

      // 健康检查
      if (pathname === '/' || pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 200, msg: 'ok', service: 'music-api', port: PORT }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 404, msg: 'Not Found' }));
    });
  });

  server.listen(PORT, () => {
    console.log(`[音乐API] 服务已启动: http://localhost:${PORT}`);
    console.log(`[音乐API] 支持平台: 酷我(kw) 酷狗(kg) 网易(wy) QQ(tx) 咪咕(mg)`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[音乐API] 端口 ${PORT} 已被占用，可能服务已在运行`);
    } else {
      console.error('[音乐API] 启动失败:', err.message);
    }
  });

  return server;
}

module.exports = { createApiServer };
