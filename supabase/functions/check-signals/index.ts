// Seuil Backend — vérification périodique des signaux (BTC, ETH, SOL, DOGE, FLOKI)
// Appelée par pg_cron toutes les X minutes. Lit/écrit l'état dans la table bot_state,
// et envoie une notification push via ntfy.sh quand un signal actionnable apparaît.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PAIRS: Record<string, string> = {
  "BTC/USD": "XBTUSD",
  "ETH/USD": "ETHUSD",
  "SOL/USD": "SOLUSD",
  "DOGE/USD": "XDGUSD",
  "FLOKI/USD": "FLOKIUSD",
};
const INTERVAL = 15; // minutes, cohérent avec Seuil Multi

function computeEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let ema = values[0];
  for (let i = 0; i < values.length; i++) {
    ema = i === 0 ? values[0] : values[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function computeRSI(values: number[], period = 14): number[] {
  const out = new Array(values.length).fill(50);
  let gains = 0, losses = 0;
  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (i <= period) {
      if (diff >= 0) gains += diff; else losses -= diff;
      if (i === period) {
        const rs = losses === 0 ? 100 : (gains / period) / (losses / period);
        out[i] = 100 - 100 / (1 + rs);
      }
    } else {
      const gain = diff > 0 ? diff : 0, loss = diff < 0 ? -diff : 0;
      gains = (gains * (period - 1) + gain) / period;
      losses = (losses * (period - 1) + loss) / period;
      const rs = losses === 0 ? 100 : gains / losses;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

function computeATR(candles: { high: number; low: number; close: number }[], period = 14): number {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  if (!trs.length) return 0;
  const n = Math.min(period, trs.length);
  return trs.slice(-n).reduce((a, b) => a + b, 0) / n;
}

async function fetchCandles(restPair: string) {
  const res = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${restPair}&interval=${INTERVAL}`);
  const json = await res.json();
  const key = Object.keys(json.result || {}).find((k) => k !== "last");
  const rows = (key && json.result[key]) || [];
  return rows.map((r: any[]) => ({ open: +r[1], high: +r[2], low: +r[3], close: +r[4] }));
}

async function notify(topic: string, title: string, body: string, priority = "high") {
  await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers: { Title: title, Priority: priority, Tags: "rotating_light" },
    body,
  });
}

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: state, error } = await supabase.from("bot_state").select("*").eq("id", 1).single();
  if (error || !state) return new Response("no state", { status: 500 });

  const { equity, target, floor_amount, risk_per_trade, ntfy_topic } = state;
  const activeTrade = state.active_trade as { pair: string; entry: number; sl: number; tp: number } | null;
  const lastSignalTypes = (state.last_signal_types || {}) as Record<string, string>;
  let lastExitType = state.last_exit_type || "hold";

  const buffer = equity - floor_amount;
  const lossesLeft = risk_per_trade > 0 ? Math.floor(buffer / risk_per_trade) : 0;
  const nearTarget = equity >= target - 20;

  const results: Record<string, any> = {};

  for (const [pair, restPair] of Object.entries(PAIRS)) {
    try {
      const candles = await fetchCandles(restPair);
      if (candles.length < 6) continue;
      const closes = candles.map((c: any) => c.close);
      const i = closes.length - 1;
      const emaFast = Math.min(9, Math.max(2, closes.length - 1));
      const emaSlow = Math.min(21, Math.max(3, closes.length - 1));
      const ema9 = computeEMA(closes, emaFast), ema21 = computeEMA(closes, emaSlow);
      const rsi = computeRSI(closes, Math.min(14, closes.length - 1));
      const bullish = ema9[i] > ema21[i];
      const rsiVal = rsi[i];

      let type = "hold";
      if (buffer <= 10 || lossesLeft <= 2) type = "pause";
      else if (bullish && rsiVal < 70) type = "buy";

      results[pair] = { type, price: closes[i] };

      // Signal d'entrée : uniquement si aucune position n'est déjà ouverte
      if (type === "buy" && lastSignalTypes[pair] !== "buy" && !activeTrade) {
        const atr = computeATR(candles, 14);
        const sl = closes[i] - atr * 1.5, tp = closes[i] + atr * 2.5;
        const desired = nearTarget ? Math.min(risk_per_trade, 2.5) : risk_per_trade;
        await notify(
          ntfy_topic,
          `${pair} — Signal ACHAT`,
          `Prix ${closes[i]} · Stop ${sl.toFixed(6)} · Objectif ${tp.toFixed(6)} · Risque suggéré $${desired}`
        );
      }
      lastSignalTypes[pair] = type;

      // Surveillance de sortie si une position est ouverte sur cette paire
      if (activeTrade && activeTrade.pair === pair) {
        const price = closes[i];
        let exitType = "hold";
        if (price <= activeTrade.sl) exitType = "sell";
        else if (price >= activeTrade.tp) exitType = "buy";

        if (exitType !== "hold" && lastExitType === "hold") {
          const msg = exitType === "sell"
            ? `Stop loss touché (${activeTrade.sl.toFixed(6)}) — coupe la position.`
            : `Objectif atteint (${activeTrade.tp.toFixed(6)}) — prends le profit.`;
          await notify(ntfy_topic, `${pair} — VENDS`, msg, "urgent");
        }
        lastExitType = exitType;
      }
    } catch (e) {
      results[pair] = { error: String(e) };
    }
  }

  await supabase.from("bot_state").update({
    last_signal_types: lastSignalTypes,
    last_exit_type: lastExitType,
    updated_at: new Date().toISOString(),
  }).eq("id", 1);

  return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
});

