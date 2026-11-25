// Patient deep-coin bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: fast entries lose on this market. A 2-slot fill lands on the burst
// peak and the price then retraces, so every sniper and momentum shape
// tested on the dev window loses 5-15% per trade. This bot does the
// opposite: it buys only DEEP coins (real SOL >= 10) whose price has been
// flat over the last 30 trades, with steady buy-dominated flow from many
// distinct buyers. A flat entry has no burst for the fill to chase, so the
// 2-slot latency barely matters; wide exits (+25% / -10%) then let the
// occasional runner pay for the losers. It is still slightly negative on
// the dev window (about -2% per trade), as is every shape the house's own
// pilot bots show there, but it loses the least and draws down the least.
// It never chases a burst and never re-enters a coin it just exited. Every
// decision is a pure function of the events in the batches the harness
// sends, so two runs produce identical orders.
//
// Risk controls:
//   - fixed small size (at most 0.10 SOL per buy, ~1% of the 10 SOL capital)
//   - at most 5 open positions at once
//   - stop-loss -10%, take-profit +25%, and a time exit after 100 further
//     prints on the coin
//   - sell slippage wide open so exits execute even in a crash instead of
//     riding a dump down while the sell keeps rejecting
//   - rug filters: skip coins whose creator is selling, coins with almost no
//     real SOL in the curve, and coins with only one or two buyers
//   - a global brake: if marked equity falls 15% below its peak, stop
//     opening new positions and only manage exits

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;

// --- tuned constants (round numbers, deliberately not overfit) ---
// Shape found in offline studies of the dev window (128k trades, 1,222
// mints): every fast-entry shape loses 5-15% per trade, because a 2-slot
// fill lands on the burst peak and the price then retraces. The least-bad
// shape is the opposite: buy DEEP coins (real SOL >= 10) whose price has
// been FLAT over the last 30 trades, with steady buy-dominated flow. The
// flat entry has almost no burst for the fill to chase, so the 2-slot
// latency barely matters, and the wide exits (+25% / -10%) let the
// occasional runner pay for the losers. Still slightly negative on the dev
// window (about -2% per trade), like every shape the house's own pilot
// bots show there, but with the smallest loss and the smallest drawdown.
const BUY_SIZE_LAMPORTS = 100_000_000n; // 0.10 SOL per entry; deep curves allow the full size
const MIN_BUY_LAMPORTS = 12_000_000n; // 0.012 SOL: just above the 0.01 SOL round-trip bar.
// NOTE: the harness caps one batch's buys on a mint at 1% of its real SOL
// reserve, so a 0.10 SOL buy needs >= 10 SOL of real reserve and a 0.012 SOL
// buy needs >= 1.2 SOL. Sizing below therefore takes min(BUY_SIZE, cap)
// instead of a fixed size: small curves still get a (small) trade, deep
// curves get the full size, and the tx-fee share stays low on the big ones.
const MAX_POSITIONS = 5;
const MIN_TRADES_BEFORE_ENTRY = 30; // need a full 30-trade window to read
const MIN_REAL_SOL_LAMPORTS = 10_000_000_000n; // >= 10 SOL of real money in the curve
const MIN_DISTINCT_BUYERS = 8;
const WINDOW_TRADES = 30; // recent trades kept per mint (flow + momentum read)
const MIN_MOMENTUM_BPS = -500; // price flat-ish over the window: -5% ...
const MAX_MOMENTUM_BPS = 1000; // ... to +10% (never buy into a burst)
const MIN_BUY_SHARE_BPS = 5500; // buys must be >= 55% of recent volume
const MIN_RECENT_BUY_VOL_LAMPORTS = 50_000_000n; // >= 0.05 SOL of buys in the window
const CREATOR_SELL_TOLERANCE_BPS = 1500; // creator sells above 15% of all-time buy volume = rug
const TAKE_PROFIT_BPS = 2500; // +25%
const STOP_LOSS_BPS = 1000; // -10%
const TIME_EXIT_TRADES = 100; // give a trade at most 100 further prints to run
const TIME_EXIT_SLOTS = 6000; // backstop for a coin that goes quiet
const REENTRY_COOLDOWN_SLOTS = 5000;
const EQUITY_BRAKE_BPS = 1500; // stop opening when equity is 15% under its peak
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 10000; // sells must execute even in a crash: never ride a -70% dump

interface RecentTrade {
  slot: number;
  isBuy: boolean;
  user: string;
  solLamports: bigint;
  price: number; // SOL per token, virtual reserves ratio
}

interface MintTrack {
  creator: string | null;
  createdSlot: number;
  trades: RecentTrade[];
  totalTrades: number; // every trade ever seen on this mint (trades[] is capped)
  creatorSellLamports: bigint;
  buyVolAllTime: bigint;
  lastExitSlot: number; // -1 when never traded
  lastSeenSlot: number;
}

interface OpenTrade {
  mint: string;
  entryPrice: number;
  peakPrice: number;
  entrySlot: number;
  entryTradeIndex: number; // totalTrades on this mint when the buy filled
  tokens: bigint;
  costLamports: bigint;
}

/** Price of one token unit in lamports, from a curve's virtual reserves. */
export function curvePrice(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const tokens = Number(curve.virtual_token_reserves);
  const quote = Number(curve.virtual_quote_reserves);
  if (tokens <= 0 || quote <= 0) return 0;
  return quote / tokens;
}

export class CautiousMomentum {
  readonly tracks = new Map<string, MintTrack>();
  readonly open = new Map<string, OpenTrade>();
  readonly rejects = new Map<string, number>();
  peakEquityLamports = 0n;
  buysSent = 0;
  sellsSent = 0;
  batchesSeen = 0;
  eventsSeen = 0;
  candidatesSeen = 0;
  gateBraking = 0;
  gateCommitted = 0;

  diagSummary(): string {
    return (
      `batches=${this.batchesSeen} events=${this.eventsSeen} ` +
      `candidates=${this.candidatesSeen} tracks=${this.tracks.size} ` +
      `gate_braking=${this.gateBraking} gate_committed=${this.gateCommitted}`
    );
  }

  /** Count a rejected entry check by reason (diagnostics on stderr only). */
  reject(reason: string): undefined {
    this.rejects.set(reason, (this.rejects.get(reason) ?? 0) + 1);
    return undefined;
  }

  rejectSummary(): string {
    return [...this.rejects.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason}=${n}`)
      .join(' ');
  }

  /** Fold one batch of events into the per-mint tracks. Call before deciding orders. */
  observe(state: BotState, batch: Batch): void {
    this.eventsSeen += batch.events.length;
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        let track = this.tracks.get(event.mint);
        if (track === undefined) {
          track = {
            creator: event.creator,
            createdSlot: event.slot,
            trades: [],
            totalTrades: 0,
            creatorSellLamports: 0n,
            buyVolAllTime: 0n,
            lastExitSlot: -1,
            lastSeenSlot: event.slot,
          };
          this.tracks.set(event.mint, track);
        } else {
          track.creator = event.creator;
          track.createdSlot = event.slot;
        }
        track.lastSeenSlot = event.slot;
      } else if (event.event === 'TradeEvent') {
        let track = this.tracks.get(event.mint);
        if (track === undefined) {
          track = {
            creator: event.creator,
            createdSlot: -1,
            trades: [],
            totalTrades: 0,
            creatorSellLamports: 0n,
            buyVolAllTime: 0n,
            lastExitSlot: -1,
            lastSeenSlot: event.slot,
          };
          this.tracks.set(event.mint, track);
        }
        // Price from the trade's own post-trade reserves: the curve state the
        // shim holds already reflects the whole batch, so every trade in one
        // batch would otherwise read the same end-of-batch price.
        const tokenReserves = Number(event.virtual_token_reserves);
        const quoteReserves = Number(event.virtual_quote_reserves);
        const price = tokenReserves > 0 && quoteReserves > 0 ? quoteReserves / tokenReserves : 0;
        const sol = BigInt(event.sol_amount);
        track.trades.push({ slot: event.slot, isBuy: event.is_buy, user: event.user, solLamports: sol, price });
        track.totalTrades += 1;
        if (track.trades.length > WINDOW_TRADES) track.trades.splice(0, track.trades.length - WINDOW_TRADES);
        if (event.is_buy) {
          track.buyVolAllTime += sol;
        } else if (track.creator !== null && event.user === track.creator) {
          track.creatorSellLamports += sol;
        }
        track.lastSeenSlot = event.slot;
      } else {
        // CompleteEvent: the curve is done; drop its track so it is never re-entered.
        this.tracks.delete(event.mint);
      }
    }

    // Reconcile open trades with the account the harness reports: a fill that
    // closed a position (harness flatten/complete/writeoff) removes it here,
    // and a buy fill records the entry price at the fill's batch.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        const price = curvePrice(state, fill.mint);
        if (price > 0) {
          const track = this.tracks.get(fill.mint);
          this.open.set(fill.mint, {
            mint: fill.mint,
            entryPrice: price,
            peakPrice: price,
            entrySlot: batch.slot,
            entryTradeIndex: track !== undefined ? track.totalTrades : 0,
            tokens: BigInt(fill.token_amount),
            costLamports: BigInt(fill.quote_lamports),
          });
        }
      } else {
        const trade = this.open.get(fill.mint);
        if (trade !== undefined) {
          const track = this.tracks.get(fill.mint);
          if (track !== undefined) track.lastExitSlot = batch.slot;
          // A partial sell leaves the rest open; a full sell closes the trade.
          const remaining = trade.tokens - BigInt(fill.token_amount);
          if (remaining <= 0n) this.open.delete(fill.mint);
          else trade.tokens = remaining;
        }
      }
    }
    // Positions the account no longer holds are gone (harness closed them).
    for (const mint of [...this.open.keys()]) {
      if (!state.positions.has(mint)) {
        const track = this.tracks.get(mint);
        if (track !== undefined) track.lastExitSlot = batch.slot;
        this.open.delete(mint);
      }
    }
  }

  /** Marked equity: cash plus positions at current curve prices. */
  equityLamports(state: BotState): bigint {
    let equity = state.cash;
    for (const [mint, holding] of state.positions) {
      const price = curvePrice(state, mint);
      if (price <= 0) continue;
      const tokens = Number(holding.token_amount);
      // curvePrice is already lamports per token unit, so tokens * price is
      // lamports directly: no extra 1e9 factor (that bug once valued a
      // 0.1 SOL position at ~1e17 lamports and jammed the equity brake on).
      equity += BigInt(Math.floor(tokens * price));
    }
    return equity;
  }

  /** Decide this batch's orders: exits first, then at most one new entry per mint. */
  decide(state: BotState, batch: Batch): OrderInput[] {
    this.batchesSeen += 1;
    const orders: OrderInput[] = [];
    const equity = this.equityLamports(state);
    if (equity > this.peakEquityLamports) this.peakEquityLamports = equity;
    const braking =
      this.peakEquityLamports > 0n &&
      equity < (this.peakEquityLamports * BigInt(10_000 - EQUITY_BRAKE_BPS)) / 10_000n;

    // --- exits for every open trade ---
    for (const [mint, trade] of this.open) {
      const holding = state.positions.get(mint);
      if (holding === undefined || holding.token_amount <= 0n) continue;
      const price = curvePrice(state, mint);
      if (price <= 0) continue;
      if (price > trade.peakPrice) trade.peakPrice = price;
      const gainBps = Math.floor(((price - trade.entryPrice) / trade.entryPrice) * 10_000);
      const heldSlots = batch.slot - trade.entrySlot;
      const track = this.tracks.get(mint);
      const printsSinceEntry = track !== undefined ? track.totalTrades - trade.entryTradeIndex : 0;
      const takeProfit = gainBps >= TAKE_PROFIT_BPS;
      const stopLoss = gainBps <= -STOP_LOSS_BPS;
      // The trade had its window: 100 further prints on the coin, or a long
      // quiet stretch, and it never ran — get out at whatever the price is.
      const stale = printsSinceEntry >= TIME_EXIT_TRADES || heldSlots >= TIME_EXIT_SLOTS;
      if (takeProfit || stopLoss || stale) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        this.sellsSent += 1;
      }
    }

    // --- entries: only coins that traded in this batch, only while not braking ---
    if (braking) this.gateBraking += 1;
    else if (state.committedPositionCount() >= MAX_POSITIONS) this.gateCommitted += 1;
    if (!braking && state.committedPositionCount() < MAX_POSITIONS) {
      const candidates = new Set<string>();
      for (const event of batch.events) {
        if (event.event === 'TradeEvent') candidates.add(event.mint);
      }
      this.candidatesSeen += candidates.size;
      for (const mint of candidates) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (state.committedPositionCount() + countBuys(orders) >= MAX_POSITIONS) break;
        const buy = this.maybeBuy(state, batch, mint);
        if (buy !== undefined) {
          orders.push(buy);
          this.buysSent += 1;
        }
      }
    }
    return orders;
  }

  /** One entry check for a mint. Returns a buy order or undefined. */
  maybeBuy(state: BotState, batch: Batch, mint: string): OrderInput | undefined {
    if (this.open.has(mint)) return this.reject('already_open');
    if (state.positions.has(mint)) return this.reject('already_held');
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'buy' && pending.order.mint === mint) return this.reject('buy_pending');
    }
    const track = this.tracks.get(mint);
    if (track === undefined) return this.reject('no_track');
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return this.reject('no_curve_or_complete');
    // Need a full 30-trade window to read the coin. No upper age limit: deep
    // coins are traded for hours, and the edge is patience, not youth.
    if (track.trades.length < MIN_TRADES_BEFORE_ENTRY) return this.reject('few_trades');
    if (track.lastExitSlot >= 0 && batch.slot - track.lastExitSlot < REENTRY_COOLDOWN_SLOTS) {
      return this.reject('cooldown');
    }
    if (curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS) return this.reject('low_real');

    const recent = track.trades;
    const last = recent[recent.length - 1];
    // Enter on a buy print from a real outsider, not the creator buying their own coin.
    if (!last.isBuy || (track.creator !== null && last.user === track.creator)) {
      return this.reject('last_not_outsider_buy');
    }

    // Flat price over the window: up a little or down a little, never a
    // burst. A burst means the 2-slot fill lands on the peak and the price
    // then retraces; a flat coin's fill lands where the decision was made.
    const first = recent[0];
    if (first.price <= 0 || last.price <= 0) return this.reject('bad_price');
    const momentumBps = Math.floor(((last.price - first.price) / first.price) * 10_000);
    if (momentumBps < MIN_MOMENTUM_BPS || momentumBps > MAX_MOMENTUM_BPS) return this.reject('momentum');

    // Flow over the window: buys dominate, enough buy volume, enough
    // distinct buyers. The creator's own trades are not outside money, so
    // they never count as buy-side flow here (creator sells still count as
    // sell pressure).
    let buyVol = 0n;
    let sellVol = 0n;
    const buyers = new Set<string>();
    for (const trade of recent) {
      const isCreator = track.creator !== null && trade.user === track.creator;
      if (trade.isBuy) {
        if (isCreator) continue;
        buyVol += trade.solLamports;
        buyers.add(trade.user);
      } else {
        sellVol += trade.solLamports;
      }
    }
    if (buyVol < MIN_RECENT_BUY_VOL_LAMPORTS) return this.reject('low_buy_vol');
    if (buyers.size < MIN_DISTINCT_BUYERS) return this.reject('few_buyers');
    const totalVol = buyVol + sellVol;
    if (totalVol <= 0n) return this.reject('zero_vol');
    if (Number((buyVol * 10_000n) / totalVol) < MIN_BUY_SHARE_BPS) return this.reject('buy_share');

    // Rug filter: the creator dumping into the inflows disqualifies the coin.
    if (track.buyVolAllTime > 0n) {
      const creatorShareBps = Number((track.creatorSellLamports * 10_000n) / track.buyVolAllTime);
      if (creatorShareBps > CREATOR_SELL_TOLERANCE_BPS) return this.reject('creator_dump');
    }
    // No creator sell among the most recent few prints.
    const tail = recent.slice(-5);
    if (track.creator !== null && tail.some((t) => !t.isBuy && t.user === track.creator)) {
      return this.reject('creator_sold_recent');
    }

    // Size: fixed small size, capped by the per-order reserve cap, never below
    // the round-trip minimum, never more than the free cash allows.
    const cap = state.maxBuyLamports(mint);
    let size = BUY_SIZE_LAMPORTS;
    if (cap < size) size = cap;
    if (size < MIN_BUY_LAMPORTS) return this.reject('size_cap');
    const free = state.freeCashLamports();
    const reserve = 50_000_000n; // keep 0.05 SOL of headroom in cash
    if (free - state.txFeeLamports() - reserve < size) return this.reject('low_cash');

    return { side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS };
  }
}

function countBuys(orders: readonly OrderInput[]): number {
  let n = 0;
  for (const order of orders) if (order.side === 'buy') n += 1;
  return n;
}
