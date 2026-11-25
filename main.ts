// Entrypoint for the Pump.fun Bot Sprint entry.
//
// The harness speaks agent-fun/replay/v2 over stdin/stdout: it sends one
// hello line, then one batch per slot, then a done line. This file only owns
// the wire: it hands every batch to the strategy in strategy.ts and sends
// back exactly one reply per batch with that batch's orders. All trading
// decisions live in strategy.ts.
//
// Determinism matters: the grader runs the bot twice and the two action logs
// must match byte for byte, so nothing here reads the clock, the environment
// or Math.random. Diagnostics go to stderr; stdout carries replies only.

import { runBot } from './vendor/makefun-bot.ts';
import type { BotState, Batch } from './vendor/makefun-bot.ts';
import { CautiousMomentum } from './strategy.ts';

const bot = new CautiousMomentum();

await runBot({
  onHello(state: BotState): void {
    // One hello arrives before the first batch: capital, caps, fees and the
    // seed are in state.hello. The strategy needs no setup beyond a fresh
    // instance, but log the run's shape to stderr for local debugging.
    console.error(
      `hello: capital=${state.hello.capital.lamports} lamports ` +
        `max_open_positions=${state.hello.caps.max_open_positions} ` +
        `max_orders_per_batch=${state.hello.caps.max_orders_per_batch} ` +
        `latency_slots=${state.hello.latency_slots}`,
    );
  },

  onBatch(state: BotState, batch: Batch) {
    // One batch = one slot of market events. Fold the batch into the
    // strategy's per-mint tracks first, then decide this slot's orders.
    // A strategy error on one batch must never kill the whole run: log it
    // and answer with no orders for that slot instead.
    try {
      bot.observe(state, batch);
    } catch (error) {
      console.error(`batch seq=${batch.seq}: observe failed: ${String(error)}`);
      return [];
    }
    let orders;
    try {
      orders = bot.decide(state, batch);
    } catch (error) {
      console.error(`batch seq=${batch.seq}: decide failed: ${String(error)}`);
      return [];
    }
    if (batch.seq % 10000 === 0) {
      console.error(
        `batch seq=${batch.seq} slot=${batch.slot} ` +
          `orders=${orders.length} buys_sent=${bot.buysSent} sells_sent=${bot.sellsSent} ` +
          `open=${bot.open.size} cash=${state.cash}`,
      );
    }
    return orders;
  },

  onDone(state: BotState): void {
    // The replay ended and the harness flattened every position. Report the
    // final account so a local grade-local run shows the outcome on stderr.
    const start = BigInt(state.hello.capital.lamports);
    const pnl = state.cash - start;
    console.error(
      `done: cash=${state.cash} lamports pnl=${pnl} lamports ` +
        `positions=${state.positions.size} ` +
        `buys_sent=${bot.buysSent} sells_sent=${bot.sellsSent} ` +
        `diag: ${bot.diagSummary()} ` +
        `rejects: ${bot.rejectSummary()}`,
    );
  },
});
