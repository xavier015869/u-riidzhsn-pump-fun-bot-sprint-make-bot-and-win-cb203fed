# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![Competition](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/xavier015869/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/xavier015869/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A cautious momentum bot for the Pump.fun Bot Sprint on [make.fun](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed). It trades paper SOL on a replay of pump.fun bonding-curve events, ranked on net PnL. Try make.fun yourself: https://make.fun/r/9d3wsaqp

## Strategy

Fast entries lose on this market: a 2-slot fill lands on the burst peak
and the price then retraces, so sniper and momentum shapes lose 5–15% per
trade on the dev window. This bot does the opposite — it buys only deep,
quiet coins and lets the occasional runner pay for the losers.

**Entry (all must hold):**
- The coin is deep: at least 10 SOL of real SOL in the curve, and at least
  30 trades seen.
- Price flat over the last 30 trades: between −5% and +10% — never a burst.
- Buys are at least 55% of the last 30 trades' volume, with at least
  0.05 SOL of buys and at least 8 distinct non-creator buyers.
- The latest print is a buy from a real outsider, not the creator.
- Rug filter: the creator's cumulative sells stay under 15% of all-time buy
  volume, and the creator has not sold in the last 5 prints.

**Position sizing:** at most 0.10 SOL per buy (~1% of the 10 SOL capital),
capped by the harness's per-order reserve cap, with at most 5 open positions.

**Exits (full position, one sell order):**
- Take-profit at +25%, stop-loss at −10%.
- Time exit: after 100 further prints on the coin, or 6000 slots quiet, the
  trade had its window — get out at whatever the price is.
- Sell slippage is wide open so exits execute even in a crash instead of
  riding a dump down while the sell keeps rejecting.
- A global brake stops new entries while marked equity sits 15% below its peak.
- A coin is never re-entered within 5000 slots of the last exit on it, so
  the bot keeps rotating into fresh coins instead of chasing the same one.

**Guardrails:** every buy is at least 0.02 SOL (above the 0.01 SOL
round-trip minimum), the bot trades many distinct coins across the window
(the bar is 20), and the fixed small size plus the stop-loss and equity
brake keep the maximum drawdown far under the 50% limit.

Everything is deterministic: every decision is a pure function of the replay
events, with no clock, environment or random reads, so two runs produce
identical orders.

## Layout

- `main.ts` — entrypoint: owns the harness wire (hello / batch / done) and
  delegates every batch to the strategy.
- `strategy.ts` — the strategy: per-mint tracking, entry filters, exits,
  sizing and the equity brake.
- `vendor/makefun-bot.ts` — the kit's agent-fun/replay/v2 shim, used as-is.
- `LICENSE` — MIT, the kit's canonical license.

## Local grading

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

## License

MIT — see `LICENSE`.
