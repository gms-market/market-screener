const fs = require('fs');

async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.NS?interval=1d&range=1d`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const quote = result.indicators?.quote?.[0];
    const ltp = meta.regularMarketPrice || meta.chartPreviousClose || 0;
    const prevClose = meta.chartPreviousClose || ltp;
    const volume = (quote?.volume || []).reduce((acc, v) => acc + (v || 0), 0) || meta.regularMarketVolume || 0;
    const high = meta.regularMarketDayHigh || ltp;
    const low = meta.regularMarketDayLow || ltp;
    const vwap = parseFloat(((high + low + ltp) / 3).toFixed(2));

    return {
      sym: symbol,
      ltp: parseFloat(ltp.toFixed(2)),
      vwap: vwap,
      prevClose: parseFloat(prevClose.toFixed(2)),
      volume: volume
    };
  } catch (err) {
    console.error(`Error fetching ${symbol}:`, err.message);
    return null;
  }
}

async function runCollector() {
  const trackedTickers = [
    "HDFCBANK", "ICICIBANK", "BHARTIARTL", "SBIN", "LICI", "ITC", "HINDUNILVR",
    "LT", "BAJFINANCE", "RELIANCE", "TCS", "INFY", "AXISBANK", "KOTAKBANK",
    "M&M", "MARUTI", "SUNPHARMA", "NTPC", "POWERGRID", "TATAMOTORS", "ULTRACEMCO",
    "TITAN", "COALINDIA", "TRENT", "BEL", "HAL", "ONGC", "VEDL", "INDUSINDBK",
    "WIPRO", "HCLTECH", "TECHM", "NESTLEIND", "ASIANPAINT", "CIPLA", "APOLLOHOSP"
  ];

  console.log(`Starting real-time close scan for ${trackedTickers.length} NSE stocks...`);

  const results = [];
  for (const sym of trackedTickers) {
    const quote = await fetchQuote(sym);
    if (quote && quote.ltp > 0) {
      const priceDiffPct = ((quote.ltp - quote.prevClose) / quote.prevClose) * 100;
      const turnoverCr = parseFloat(((quote.volume * quote.ltp) / 10000000).toFixed(2));
      const netFlow = parseFloat(((turnoverCr * priceDiffPct) / 100).toFixed(2));
      const momScore = parseFloat((priceDiffPct * Math.log10(Math.max(turnoverCr, 1) + 10)).toFixed(1));
      const signal = netFlow > 15 ? "STRONG BUY" : netFlow > 0 ? "BUY" : netFlow < -15 ? "STRONG SELL" : "SELL";

      results.push({
        sym: quote.sym,
        ltp: quote.ltp,
        vwap: quote.vwap,
        price: quote.ltp,
        netFlow: netFlow,
        totalQty: quote.volume,
        momScore: momScore,
        signal: signal
      });
    }
  }

  console.log(`Successfully collected live close data for ${results.length} stocks.`);

  const output = {
    updatedAt: new Date().toISOString(),
    totalStocksTraded: results.length,
    allStocks: results.slice().sort((a, b) => b.netFlow - a.netFlow),
    buys: results.filter(d => d.netFlow > 0).sort((a, b) => b.netFlow - a.netFlow),
    sells: results.filter(d => d.netFlow < 0).sort((a, b) => a.netFlow - b.netFlow),
    momUp: results.filter(d => d.momScore > 0).sort((a, b) => b.momScore - a.momScore),
    momDown: results.filter(d => d.momScore < 0).sort((a, b) => a.momScore - b.momScore)
  };

  fs.writeFileSync("today.json", JSON.stringify(output, null, 2));
  console.log("today.json saved successfully.");
}

runCollector();
