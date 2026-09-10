const fs = require('fs');

async function fetchNSEDeals() {
  const url = "https://www.nseindia.com/api/snapshot-capital-market-largedeal?mode=bulk_deals";
  
  // Official session headers that bypass NSE bot protections
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/report-detail/display-bulk-and-block-deals"
  };

  try {
    // 1. Visit NSE homepage to get valid session cookies
    const sessionRes = await fetch("https://www.nseindia.com", { headers });
    const setCookie = sessionRes.headers.get("set-cookie");
    if (setCookie) {
      headers["Cookie"] = setCookie.split(';')[0];
    }

    // 2. Fetch the actual daily deal JSON
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
    const json = await res.json();
    
    const rawData = json.data || [];
    const stockMap = {};

    // 3. Process deals and calculate Net Flow + VWAP
    rawData.forEach(d => {
      const sym = d.symbol;
      const type = (d.buySell || "").toUpperCase();
      const qty = parseFloat(d.qty) || 0;
      const price = parseFloat(d.watp || d.price) || 0;
      const valCr = (qty * price) / 10000000;

      if (!sym || qty <= 0 || price <= 0) return;

      if (!stockMap[sym]) {
        stockMap[sym] = { sym, price, totalQty: 0, buyVal: 0, sellVal: 0, weightedTotal: 0 };
      }

      stockMap[sym].totalQty += qty;
      stockMap[sym].weightedTotal += (price * qty);

      if (type.includes("BUY")) stockMap[sym].buyVal += valCr;
      else if (type.includes("SELL")) stockMap[sym].sellVal += valCr;
    });

    const parsed = Object.values(stockMap).map(s => {
      const netFlow = parseFloat((s.buyVal - s.sellVal).toFixed(2));
      const totalTurnover = s.buyVal + s.sellVal;
      const vwap = s.totalQty > 0 ? parseFloat((s.weightedTotal / s.totalQty).toFixed(2)) : s.price;
      const momScore = totalTurnover > 0 ? parseFloat(((netFlow / totalTurnover) * Math.log10(totalTurnover + 10) * 10).toFixed(1)) : 0;
      
      let conviction = Math.abs(netFlow) > 50 ? "MEGA BLOCK" : Math.abs(netFlow) > 15 ? "HIGH IMPACT" : "MODERATE";
      let signal = netFlow > 20 ? "STRONG BUY" : netFlow > 0.05 ? "BUY" : netFlow < -20 ? "STRONG SELL" : "SELL";

      return { sym: s.sym, price: vwap, netFlow, totalQty: s.totalQty, momScore, conviction, signal };
    });

    // 4. Output the structured payload
    // Output the entire universe of traded stocks, plus sorted rankings
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
    console.log("Successfully generated today.json with current market data!");
  } catch (err) {
    console.error("Fetch failed:", err.message);
    process.exit(1);
  }
}

fetchNSEDeals();
