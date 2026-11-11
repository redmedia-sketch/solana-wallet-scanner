# Solana Wallet Scanner (PWA)

Mobile-first, read-only Solana Mainnet scanner. This is an MVP starter project, not an audited trading system.

## Included
- Solana Mainnet HTTP JSON-RPC (`getTransaction`, `getSignaturesForAddress`)
- Pump.fun program `logsSubscribe` stream over WebSocket
- Manual wallet watchlist with 30-second polling
- SOL/USD from DexScreener
- Token market cap and price from DexScreener
- Filters: transaction value >= USD 10,000 and market cap >= USD 100,000
- PWA manifest + service worker; install from Android Chrome menu

## Run locally
1. Install Node.js 20+
2. `npm install`
3. `npm run dev`
4. Open the shown LAN URL on Android Chrome, or use localhost on desktop.

## Build / deploy
- `npm run build`
- Deploy the `dist/` folder to a static HTTPS host (for example Cloudflare Pages, Netlify, or Vercel).
- Open the HTTPS URL in Android Chrome -> menu -> "Add to Home screen" / "Install app".

## Important accuracy and coverage notes
- Solana's public mainnet RPC is shared infrastructure. It may rate-limit, reject WebSocket subscriptions, or not provide production-grade global indexing.
- The automatic stream subscribes to Pump.fun program logs. It is not a global Solana transaction firehose.
- Fomo.family and GMGN.ai are analytics frontends, not interchangeable public RPC protocols. This build does not scrape their private APIs. Transactions from other DEXes are only found if a watched wallet is scanned or a compatible program subscription is added.
- Market cap filtering uses DexScreener's `marketCap` field only. It deliberately does not substitute FDV when market cap is missing.
- Trade USD value is estimated from the wallet's net SOL balance change in the transaction, using the current SOL/USD quote. Rent, fees, bundled instructions, multiple swaps, wrapped SOL, and non-SOL quote assets can make this estimate differ from the exact swap notional. Treat this as a scanner signal, not accounting-grade execution data.
- Some RPC providers disable public WebSocket access. If auto stream fails, manual wallet monitoring can still work via HTTP RPC.
- No private keys, wallet signing, or trade execution are implemented. Never paste a seed phrase or private key.
- This frontend calls public APIs from the browser; API availability and CORS behavior are controlled by those providers.

## Mainnet endpoints
- HTTP: `https://api.mainnet.solana.com`
- WebSocket: `wss://api.mainnet.solana.com`

## Next production steps
- Use a dedicated RPC provider with WebSocket and transaction history.
- Add robust DEX instruction decoders (Pump.fun, PumpSwap, Raydium, Jupiter, etc.) to calculate exact swap amounts.
- Add durable server-side event ingestion, deduplication, alert delivery, and historical storage.
- Verify the current Pump.fun program IDs and any additional programs before enabling them.
