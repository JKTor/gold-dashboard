// ตัวกลางดึงราคาทอง: เบราว์เซอร์เรียก goldtraders.or.th ตรงๆ ไม่ได้ (ไม่มี CORS)
// เลยให้ Worker ไปดึงแทน แล้วส่งต่อให้หน้าเว็บที่ /api/gold
const GTA_URL = 'https://www.goldtraders.or.th/api/GoldPrices/Latest?readjson=false';
const SPOT_URL = 'https://api.gold-api.com/price/XAU';
const FX_URL = 'https://open.er-api.com/v6/latest/USD';

async function getJSON(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 gold-dashboard' },
    
  });
  if (!r.ok) throw new Error(url + ' ' + r.status);
  return r.json();
}

// สมาคมตอบ 502 เป็นพักๆ → ลองใหม่ 3 รอบ ถ้ายังพังใช้ราคาล่าสุดที่เคยดึงได้ (เก็บใน cache)
const LAST_GTA = 'https://gold.jirawong.com/__last-gta';
async function getGTA() {
  const cache = caches.default;
  for (let i = 0; i < 3; i++) {
    try {
      const g = await getJSON(GTA_URL);
      if (g.bL_SellPrice) {
        await cache.put(LAST_GTA, new Response(JSON.stringify(g), {
          headers: { 'Cache-Control': 'max-age=86400' },
        }));
        return g;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  const old = await cache.match(LAST_GTA);
  if (old) return old.json();
  throw new Error('goldtraders ไม่ตอบ');
}

async function goldData() {
  const [gta, spot, fx] = await Promise.allSettled([
    getGTA(), getJSON(SPOT_URL), getJSON(FX_URL),
  ]);
  const out = { updated: new Date().toISOString() };

  if (gta.status === 'fulfilled' && gta.value.bL_SellPrice) {
    const g = gta.value;
    out.thai = {
      barBuy: g.bL_BuyPrice,          // ทองแท่ง รับซื้อ
      barSell: g.bL_SellPrice,        // ทองแท่ง ขายออก
      jewBuy: g.oM965_BuyPrice,       // ทองรูปพรรณ รับซื้อ
      jewSell: g.oM965_SellPrice,     // ทองรูปพรรณ ขายออก
      change: g.priceChangeFromPrevDayLast,
      time: g.asTime,
      round: g.seq,
      source: 'สมาคมค้าทองคำ',
    };
    out.xau = g.goldSpot;
    out.usdthb = g.bahtPerUSD;
  } else {
    out.thaiError = gta.status === 'rejected' ? String(gta.reason) : 'bad data';
  }
  // ราคา spot สดกว่าของสมาคม (สมาคมอัปเดตเป็นรอบ)
  if (spot.status === 'fulfilled' && spot.value.price) out.xau = spot.value.price;
  if (fx.status === 'fulfilled' && fx.value.rates?.THB) out.usdthb = fx.value.rates.THB;
  return out;
}

// ฟีดข่าวที่อนุญาตให้ดึง (กันคนเอา Worker ไปใช้เป็น proxy อื่น)
const FEEDS = {
  kitco: 'https://news.google.com/rss/search?q=site:kitco.com+when:3d&hl=en-US&gl=US&ceid=US:en',
  reuters: 'https://news.google.com/rss/search?q=site:reuters.com+markets+when:1d&hl=en-US&gl=US&ceid=US:en',
  bbc: 'https://feeds.bbci.co.uk/news/business/rss.xml',
  nyt: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
  mw: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',
  cnbc: 'https://www.cnbc.com/id/10000664/device/rss/rss.html',
  fxs: 'https://www.fxstreet.com/rss/news',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/gold') {
      try {
        return Response.json(await goldData(), {
          headers: { 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' },
        });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 502 });
      }
    }
    if (url.pathname === '/api/rss') {
      const feed = FEEDS[url.searchParams.get('src')];
      if (!feed) return new Response('unknown feed', { status: 400 });
      const r = await fetch(feed, {
        headers: { 'User-Agent': 'Mozilla/5.0 gold-dashboard' },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      return new Response(r.body, {
        status: r.status,
        headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
      });
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      // ถ้าส่วนใส่ราคาพังด้วยเหตุอะไรก็ตาม ส่งหน้าเดิมไป เว็บต้องไม่ล่ม
      try { return await renderHome(request, env); } catch { return env.ASSETS.fetch(request); }
    }
    return env.ASSETS.fetch(request);
  },
};

// ─── ใส่ราคาลง HTML ก่อนส่ง (ให้ Google เห็นตัวเลขจริง ไม่ใช่ "—") ─────────────
// หน้าเว็บยังดึงราคาใหม่เองด้วย JS เหมือนเดิม ส่วนนี้แค่ทำให้ HTML แรกมีราคาอยู่แล้ว
const SSR_KEY = 'https://gold.jirawong.com/__ssr-gold';

async function cachedGold() {
  const cache = caches.default;
  const hit = await cache.match(SSR_KEY);
  if (hit) return hit.json();
  const g = await goldData();
  if (g.thai) {
    await cache.put(SSR_KEY, new Response(JSON.stringify(g), { headers: { 'Cache-Control': 'max-age=300' } }));
  }
  return g;
}

const fmtTH = (n) => (n ? n.toLocaleString('th-TH', { maximumFractionDigits: 2 }) : '—');
const fmtEN = (n) => Math.round(n).toLocaleString('en-US');

async function renderHome(request, env) {
  // ขอหน้าแบบไม่มี If-None-Match ไม่งั้นได้ 304 ไม่มีเนื้อหา แล้วเบราว์เซอร์จะใช้หน้าเก่าที่ราคาเก่า
  const page = await env.ASSETS.fetch(new Request(new URL('/', request.url)));
  let g;
  try { g = await cachedGold(); } catch { return page; }
  const t = g.thai;
  if (!t) return page; // ไม่มีราคาสมาคม ก็ส่งหน้าเดิม ให้ JS จัดการเอง

  const date = new Date().toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'long', year: 'numeric' });
  const title = `ราคาทองวันนี้ ${date} ทองแท่งขายออก ${fmtEN(t.barSell)} บาท | Gold Dashboard`;
  const desc = `ราคาทองวันนี้ ${date} จากสมาคมค้าทองคำ ทองแท่ง รับซื้อ ${fmtEN(t.barBuy)} ขายออก ${fmtEN(t.barSell)} บาท ทองรูปพรรณ รับซื้อ ${fmtEN(t.jewBuy)} ขายออก ${fmtEN(t.jewSell)} บาท พร้อมกราฟ XAU/USD และข่าวทองคำ อัปเดตทุก 5 นาที`;
  const hhmm = String(t.time || '').slice(11, 16);

  const text = (s) => ({ element(el) { el.setInnerContent(s); } });
  const attr = (name, v) => ({ element(el) { el.setAttribute(name, v); } });

  const res = new HTMLRewriter()
    .on('title', text(title))
    .on('meta[name="description"]', attr('content', desc))
    .on('meta[property="og:title"]', attr('content', title))
    .on('meta[property="og:description"]', attr('content', desc))
    .on('#barSell', text(fmtTH(t.barSell) + ' ฿'))
    .on('#barBuy', text(fmtTH(t.barBuy) + ' ฿'))
    .on('#jewSell', text(fmtTH(t.jewSell) + ' ฿'))
    .on('#jewBuy', text(fmtTH(t.jewBuy) + ' ฿'))
    .on('#jewPct', text('+' + ((t.jewSell - t.barSell) / t.barSell * 100).toFixed(2) + '%'))
    .on('#heroJew', text('฿ ' + fmtEN(t.jewSell)))
    .on('div.bar-price', text('฿ ' + fmtEN(t.barSell)))
    .on('#barSrc', text(`ราคา${t.source} ครั้งที่ ${t.round} (${hhmm} น.)`))
    .on('#xauVal', text(g.xau ? '$' + g.xau.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'))
    .on('#usdthbVal', text(g.usdthb ? g.usdthb.toFixed(2) : '—'))
    .transform(page);

  const headers = new Headers(res.headers);
  headers.delete('ETag');
  headers.set('Cache-Control', 'public, max-age=60');
  return new Response(res.body, { status: res.status, headers });
}
