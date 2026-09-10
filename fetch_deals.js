const fs = require('fs');

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function runCollector() {
  const dealsUrl = "https://www.nseindia.com/api/snapshot-capital-market-largedeal?mode=bulk_deals";
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/report-detail/display-bulk-and-block-deals"
  };

  let deals = [];

  try {
    console.log("Connecting to NSE session gateway...");
    const initRes = await fetchWithTimeout("https://www.nseindia.com", { headers }, 8000);
    const cookie = initRes.headers.get("set-cookie");
    if (cookie) headers["Cookie"] = cookie.split(';')[0];

    console.log("Fetching finalized daily bulk/block deals...");
    const res = await fetchWithTimeout(dealsUrl, { headers }, 10000);
    if (res.ok) {
      const data = await res.json();
      deals = data.data || [];
      console.log(`Successfully fetched ${deals.length} deal records from the exchange.`);
    } else {
      console.warn(`Exchange response code: ${res.status}`);
    }
  } catch (e) {
    console.warn("Connection attempt error:", e.message);
  }

  const stockMap = {};

  deals.forEach(d => {
    const sym = d.symbol;
    const type = (d.buySell || "").toUpperCase();
    const qty = parseFloat(d.qty) || 0;
    // Current executed market price / weighted traded price directly from NSE
    const price = parseFloat(d.watp || d.price) || 0;
    const valCr = (qty * price) / 10000000;

    if (!sym || qty <= 0 || price <= 0) return;

    if (!stockMap[sym]) {
      stockMap[sym] = { sym, ltp: price, totalQty: 0, buyVal: 0, sellVal: 0, weightedTotal: 0 };
    }

    stockMap[sym].totalQty += qty;
    stockMap[sym].weightedTotal += (price * qty);
    stockMap[sym].ltp = price; // Latest traded price from exchange

    if (type.includes("BUY")) stockMap[sym].buyVal += valCr;
    else if (type.includes("SELL")) stockMap[sym].sellVal += valCr;
  });

  const parsed = Object.values(stockMap).map(s => {
    const netFlow = parseFloat((s.buyVal - s.sellVal).toFixed(2));
    const totalTurnover = s.buyVal + s.sellVal;
    const vwap = s.totalQty > 0 ? parseFloat((s.weightedTotal / s.totalQty).toFixed(2)) : s.ltp;
    const ltp = parseFloat(s.ltp.toFixed(2));
    const momScore = totalTurnover > 0 ? parseFloat(((netFlow / totalTurnover) * Math.log10(totalTurnover + 10) * 10).toFixed(1)) : 0;
    let signal = netFlow > 20 ? "STRONG BUY" : netFlow > 0.05 ? "BUY" : netFlow < -20 ? "STRONG SELL" : "SELL";
    
    return {
      sym: s.sym,
      ltp: ltp,
      vwap: vwap,
      netFlow: netFlow,
      totalQty: s.totalQty,
      momScore: momScore,
      signal: signal
    };
  });

  const output = {
    updatedAt: new Date().toISOString(),
    totalStocksTraded: parsed.length,
    allStocks: parsed.sort((a, b) => b.netFlow - a.netFlow),
    buys: parsed.filter(d => d.netFlow > 0.05).sort((a, b) => b.netFlow - a.netFlow),
    sells: parsed.filter(d => d.netFlow < -0.05).sort((a, b) => a.netFlow - b.netFlow),
    momUp: parsed.filter(d => d.momScore > 2).sort((a, b) => b.momScore - a.momScore),
    momDown: parsed.filter(d => d.momScore < -2).sort((a, b) => a.momScore - b.momScore)
  };

  fs.writeFileSync("today.json", JSON.stringify(output, null, 2));
  console.log(`today.json updated with ${parsed.length} institutionally active stocks.`);
}

runCollector();
