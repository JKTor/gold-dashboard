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
    return env.ASSETS.fetch(request);
  },
};
