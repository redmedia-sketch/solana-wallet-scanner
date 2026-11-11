import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

const RPC_DEFAULT = "https://api.mainnet.solana.com";
const WS_DEFAULT = "wss://api.mainnet.solana.com";
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const MIN_USD_DEFAULT = 10000;
const MIN_MCAP_DEFAULT = 100000;

async function rpc(method, params, endpoint) {
  const res = await fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "RPC error");
  return json.result;
}
async function getSolUsd() {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`);
  if (!r.ok) throw new Error(`DexScreener HTTP ${r.status}`);
  const j = await r.json();
  const pair = (j.pairs || []).filter(p => p.chainId === "solana" && Number(p.priceUsd) > 0)
    .sort((a,b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0];
  if (!pair) throw new Error("Harga SOL belum tersedia dari DexScreener");
  return Number(pair.priceUsd);
}
async function getTokenMarket(tokenMint) {
  const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${tokenMint}`);
  if (!r.ok) throw new Error(`DexScreener token HTTP ${r.status}`);
  const pairs = await r.json();
  const best = (Array.isArray(pairs) ? pairs : [])
    .filter(p => p.chainId === "solana" && Number(p.priceUsd) > 0)
    .sort((a,b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0];
  if (!best) return null;
  return {
    symbol: best.baseToken?.symbol || "UNKNOWN",
    name: best.baseToken?.name || "Unknown token",
    price: Number(best.priceUsd),
    marketCap: Number(best.marketCap || 0),
    pairUrl: best.url || `https://dexscreener.com/solana/${best.pairAddress}`,
    dex: best.dexId || "Solana DEX"
  };
}
function txKeys(tx) {
  const keys = tx?.transaction?.message?.accountKeys || [];
  return keys.map(k => typeof k === "string" ? k : k.pubkey);
}
function getWalletDeltas(tx) {
  const meta = tx?.meta;
  if (!meta || meta.err) return [];
  const keys = txKeys(tx);
  const pre = meta.preTokenBalances || [], post = meta.postTokenBalances || [];
  const map = new Map();
  // Aggregate all token accounts for the same owner+mint (a wallet may hold several ATAs).
  for (const b of pre) {
    if (!b.owner) continue;
    const key = `${b.owner}|${b.mint}`;
    const item = map.get(key) || { owner: b.owner, mint: b.mint, before: 0n, after: 0n };
    item.before += BigInt(b.uiTokenAmount?.amount || "0");
    map.set(key, item);
  }
  for (const b of post) {
    if (!b.owner) continue;
    const key = `${b.owner}|${b.mint}`;
    const item = map.get(key) || { owner: b.owner, mint: b.mint, before: 0n, after: 0n };
    item.after += BigInt(b.uiTokenAmount?.amount || "0");
    map.set(key, item);
  }
  const out = [];
  for (const item of map.values()) {
    if (!item.owner || item.mint === SOL_MINT) continue;
    const delta = item.after - item.before;
    if (delta !== 0n) out.push({ owner: item.owner, mint: item.mint, delta });
  }
  return out.map(d => {
    const i = keys.indexOf(d.owner);
    if (i < 0) return { ...d, solDelta: null };
    let lamports = BigInt(meta.postBalances[i] || 0) - BigInt(meta.preBalances[i] || 0);
    if (i === 0) lamports += BigInt(meta.fee || 0);
    return { ...d, solDelta: lamports };
  });
}
function classifyTrade(tx, delta, solUsd) {
  if (delta.solDelta === null || !solUsd) return null;
  const tokenUp = delta.delta > 0n;
  const solDown = delta.solDelta < 0n;
  const solUp = delta.solDelta > 0n;
  if (tokenUp && solDown) return { side: "BUY", usd: Number(-delta.solDelta) / 1e9 * solUsd };
  if (!tokenUp && solUp) return { side: "SELL", usd: Number(delta.solDelta) / 1e9 * solUsd };
  return null;
}
function short(s) { return s ? `${s.slice(0,5)}…${s.slice(-5)}` : "—"; }
function timeAgo(ts) {
  if (!ts) return "Waktu tidak tersedia";
  const sec = Math.max(0, Math.floor(Date.now()/1000 - ts));
  if (sec < 60) return `${sec} dtk lalu`;
  if (sec < 3600) return `${Math.floor(sec/60)} mnt lalu`;
  return `${Math.floor(sec/3600)} jam lalu`;
}
function App() {
  const [rpcUrl, setRpcUrl] = useState(localStorage.getItem("rpcUrl") || RPC_DEFAULT);
  const [wsUrl, setWsUrl] = useState(localStorage.getItem("wsUrl") || WS_DEFAULT);
  const [minUsd, setMinUsd] = useState(Number(localStorage.getItem("minUsd") || MIN_USD_DEFAULT));
  const [minMcap, setMinMcap] = useState(Number(localStorage.getItem("minMcap") || MIN_MCAP_DEFAULT));
  const [walletInput, setWalletInput] = useState("");
  const [wallets, setWallets] = useState(() => JSON.parse(localStorage.getItem("wallets") || "[]"));
  const [events, setEvents] = useState([]);
  const [solUsd, setSolUsd] = useState(null);
  const [connected, setConnected] = useState(false);
  const [autoOn, setAutoOn] = useState(false);
  const [manualOn, setManualOn] = useState(false);
  const [tab, setTab] = useState("feed");
  const [status, setStatus] = useState("Siap menghubungkan ke Solana Mainnet");
  const [error, setError] = useState("");
  const [lastUpdate, setLastUpdate] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const seen = useRef(new Set());
  const wsRef = useRef(null);
  const busyRef = useRef(false);

  useEffect(() => { localStorage.setItem("wallets", JSON.stringify(wallets)); }, [wallets]);
  useEffect(() => { localStorage.setItem("rpcUrl", rpcUrl); localStorage.setItem("wsUrl", wsUrl); localStorage.setItem("minUsd", String(minUsd)); localStorage.setItem("minMcap", String(minMcap)); }, [rpcUrl,wsUrl,minUsd,minMcap]);
  useEffect(() => {
    getSolUsd().then(setSolUsd).catch(e => setError(e.message));
    const id = setInterval(() => getSolUsd().then(setSolUsd).catch(e => setError(e.message)), 30000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(()=>{});
  }, []);

  async function processSignature(signature, source, watchedWallet = "") {
    const seenKey = `${signature}:${watchedWallet || "AUTO"}`;
    if (seen.current.has(seenKey)) return;
    seen.current.add(seenKey);
    if (seen.current.size > 1500) seen.current = new Set([...seen.current].slice(-750));
    try {
      const tx = await rpc("getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }], rpcUrl);
      if (!tx || tx.meta?.err) return;
      const deltas = getWalletDeltas(tx);
      for (const d of deltas) {
        if (watchedWallet && d.owner !== watchedWallet) continue;
        const trade = classifyTrade(tx, d, solUsd);
        if (!trade || trade.usd < minUsd) continue;
        const market = await getTokenMarket(d.mint).catch(()=>null);
        if (!market || !market.marketCap || market.marketCap < minMcap) continue;
        const row = {
          id: signature + d.owner + d.mint, signature, wallet: d.owner, mint: d.mint,
          side: trade.side, usd: trade.usd, marketCap: market.marketCap, token: market.symbol,
          tokenName: market.name, price: market.price, pairUrl: market.pairUrl,
          source, timestamp: tx.blockTime || Math.floor(Date.now()/1000)
        };
        setEvents(prev => [row, ...prev.filter(x=>x.id !== row.id)].slice(0,150));
      }
    } catch (e) {
      setError(`Gagal membaca transaksi ${short(signature)}: ${e.message}`);
    }
  }

  async function startAuto() {
    if (wsRef.current) wsRef.current.close();
    setError(""); setStatus("Membuka stream Pump.fun…");
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true); setAutoOn(true); setStatus("Terhubung • Pump.fun logsSubscribe");
        ws.send(JSON.stringify({ jsonrpc:"2.0", id:1, method:"logsSubscribe", params:[{ mentions:[PUMP_PROGRAM] }, { commitment:"confirmed" }] }));
      };
      ws.onmessage = e => {
        const msg = JSON.parse(e.data);
        if (msg.error) { setError(msg.error.message || "WebSocket RPC error"); return; }
        const sig = msg.params?.result?.value?.signature;
        const failed = msg.params?.result?.value?.err;
        if (sig && !failed) processSignature(sig, "Pump.fun");
      };
      ws.onerror = () => { setError("WebSocket gagal. RPC publik dapat membatasi koneksi."); setConnected(false); };
      ws.onclose = () => { setConnected(false); setAutoOn(false); setStatus("Stream terputus"); };
    } catch (e) { setError(e.message); setAutoOn(false); }
  }
  function stopAuto() {
    if (wsRef.current) wsRef.current.close();
    wsRef.current = null; setAutoOn(false); setConnected(false); setStatus("Auto Scanner dihentikan");
  }
  async function scanWallet(wallet) {
    try {
      const sigs = await rpc("getSignaturesForAddress", [wallet, { limit: 25, commitment: "confirmed" }], rpcUrl);
      for (const item of [...(sigs || [])].reverse()) {
        if (!item.err) await processSignature(item.signature, "Manual wallet", wallet);
      }
      setLastUpdate(new Date());
    } catch (e) { setError(`Wallet ${short(wallet)}: ${e.message}`); }
  }
  useEffect(() => {
    if (!manualOn || wallets.length === 0) return;
    let cancelled = false;
    const run = async () => {
      if (busyRef.current || cancelled) return;
      busyRef.current = true;
      for (const w of wallets) { if (cancelled) break; await scanWallet(w); }
      busyRef.current = false;
    };
    run();
    const id = setInterval(run, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [manualOn, wallets, rpcUrl, solUsd, minUsd, minMcap]);

  function addWallet() {
    const value = walletInput.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) { setError("Format alamat Solana tidak valid."); return; }
    if (wallets.includes(value)) { setError("Wallet sudah ada di watchlist."); return; }
    setWallets(v => [...v, value]); setWalletInput(""); setError("");
  }
  const buys = events.filter(e=>e.side==="BUY").length;
  const sells = events.filter(e=>e.side==="SELL").length;
  const total = events.reduce((s,e)=>s+e.usd,0);
  const fmt = n => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(n || 0);

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-icon">⌁</div><div><b>SOLANA SCANNER</b><small>WALLET INTELLIGENCE</small></div></div>
      <button className="icon-btn" onClick={()=>setSettingsOpen(v=>!v)} aria-label="Pengaturan">⚙</button>
    </header>
    <main>
      <div className="network-row"><span className={`dot ${connected ? "live" : ""}`}></span><span> SOLANA MAINNET</span><span className="network-spacer"/><span className="live-label">{connected ? "STREAM LIVE" : "READ-ONLY"}</span></div>
      <section className="hero-card">
        <div className="hero-head"><span>HARGA SOL / USD</span><span className="source-tag">DEXSCREENER</span></div>
        <div className="sol-price">{solUsd ? fmt(solUsd) : "Memuat…"}</div>
        <div className="hero-foot"><span>Data pasar aktual</span><span>{lastUpdate ? `Update ${lastUpdate.toLocaleTimeString()}` : "Refresh 30 detik"}</span></div>
      </section>
      <section className="stats-grid">
        <div className="stat"><span>TRANSAKSI TERFILTER</span><b>{events.length}</b><small>Ambang ≥ {fmt(minUsd)}</small></div>
        <div className="stat"><span>NILAI TERDETEKSI</span><b>{fmt(total)}</b><small>Akumulasi feed</small></div>
        <div className="stat buy-stat"><span>BUY</span><b>{buys}</b><small>Transaksi masuk</small></div>
        <div className="stat sell-stat"><span>SELL</span><b>{sells}</b><small>Transaksi keluar</small></div>
      </section>

      {settingsOpen && <section className="panel settings">
        <div className="section-title">PENGATURAN SCANNER</div>
        <label>RPC HTTP endpoint<input value={rpcUrl} onChange={e=>setRpcUrl(e.target.value)} /></label>
        <label>RPC WebSocket endpoint<input value={wsUrl} onChange={e=>setWsUrl(e.target.value)} /></label>
        <div className="two-fields"><label>Minimal transaksi USD<input type="number" value={minUsd} onChange={e=>setMinUsd(Math.max(0,Number(e.target.value)))} /></label><label>Minimal market cap USD<input type="number" value={minMcap} onChange={e=>setMinMcap(Math.max(0,Number(e.target.value)))} /></label></div>
        <p className="muted">RPC publik bersama dapat terkena rate limit (429/403). Gunakan endpoint publik Solana atau RPC lain yang kompatibel.</p>
      </section>}

      <section className="panel scanner-panel">
        <div className="section-heading"><div><div className="section-title">HYBRID SCANNER</div><div className="muted">Pemantauan otomatis + watchlist wallet</div></div><span className="hybrid-pill">HYBRID</span></div>
        <div className="scanner-row">
          <div><b>Auto Scanner</b><small>Pump.fun program activity</small></div>
          <button className={autoOn ? "stop-btn" : "start-btn"} onClick={autoOn ? stopAuto : startAuto}>{autoOn ? "STOP" : "START"}</button>
        </div>
        <div className="scanner-row">
          <div><b>Manual Wallet Scanner</b><small>{wallets.length} wallet dalam watchlist • polling 30 detik</small></div>
          <button className={manualOn ? "stop-btn" : "start-btn"} onClick={()=>setManualOn(v=>!v)}>{manualOn ? "STOP" : "START"}</button>
        </div>
        <div className="status-line"><span className={`dot ${connected || manualOn ? "live" : ""}`}></span>{status}</div>
      </section>

      <nav className="tabs">
        <button className={tab==="feed" ? "active" : ""} onClick={()=>setTab("feed")}>ACTIVITY FEED</button>
        <button className={tab==="wallets" ? "active" : ""} onClick={()=>setTab("wallets")}>WALLET WATCHLIST</button>
      </nav>
      {tab==="feed" ? <section className="feed">
        <div className="feed-head"><b>TRANSAKSI BESAR</b><span>{events.length} hasil</span></div>
        {events.length === 0 ? <div className="empty"><div className="empty-icon">⌕</div><b>Belum ada transaksi yang memenuhi filter</b><p>Mulai Auto Scanner atau tambahkan wallet ke watchlist. Hasil hanya ditampilkan setelah data on-chain dan market cap berhasil diverifikasi.</p></div> :
          events.map(e=><article className="event-card" key={e.id}>
            <div className="event-top"><span className={`side ${e.side.toLowerCase()}`}>{e.side}</span><b>{fmt(e.usd)}</b><span className="event-time">{timeAgo(e.timestamp)}</span></div>
            <div className="token-line"><b>{e.token}</b><span>{e.tokenName}</span><span className="mcap">MC {fmt(e.marketCap)}</span></div>
            <div className="wallet-line">WALLET <a href={`https://solscan.io/account/${e.wallet}`} target="_blank" rel="noreferrer">{short(e.wallet)}</a><span>• {e.source}</span></div>
            <div className="event-links"><a href={`https://solscan.io/tx/${e.signature}`} target="_blank" rel="noreferrer">TRANSACTION ↗</a><a href={e.pairUrl} target="_blank" rel="noreferrer">DEXSCREENER ↗</a></div>
          </article>)
        }
      </section> : <section className="panel watchlist">
        <div className="section-title">TAMBAHKAN WALLET SOLANA</div>
        <div className="add-row"><input placeholder="Alamat wallet Solana…" value={walletInput} onChange={e=>setWalletInput(e.target.value)} onKeyDown={e=>e.key==="Enter" && addWallet()} /><button onClick={addWallet}>+</button></div>
        {wallets.length===0 ? <div className="empty compact">Belum ada wallet. Masukkan alamat publik wallet yang ingin dipantau.</div> :
          wallets.map(w=><div className="wallet-item" key={w}><div><b>{short(w)}</b><small>{w}</small></div><a href={`https://solscan.io/account/${w}`} target="_blank" rel="noreferrer">↗</a><button className="remove" onClick={()=>setWallets(v=>v.filter(x=>x!==w))}>×</button></div>)}
      </section>}
      {error && <div className="error-box"><span>!</span><div>{error}</div><button onClick={()=>setError("")}>×</button></div>}
      <section className="disclaimer"><b>CATATAN DATA</b><p>Mode Auto saat ini memantau log program Pump.fun melalui logsSubscribe. Mode Manual memindai transaksi wallet yang dimasukkan. Fomo.family dan GMGN.ai bukan endpoint RPC protokol publik yang dapat diasumsikan tersedia; aktivitas on-chain mereka hanya terdeteksi jika melibatkan program yang dipantau atau wallet yang ditambahkan. Tidak ada eksekusi BUY/SELL atau akses private key.</p></section>
    </main>
    <footer><span>SCANNER v1.0</span><span>ON-CHAIN • READ ONLY</span></footer>
  </div>;
}

createRoot(document.getElementById("root")).render(<App />);
