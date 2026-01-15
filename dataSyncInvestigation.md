Data Integrity & Chain Sync Investigation
Recent Fixes (2026-01-15)
- Added a global cross-job lock + DB advisory lock so MM, inventory sync, and full sync cannot overlap across processes.
- Lowered pending fill tolerance to 0.0001 and extend TTL on partial confirmations to avoid expiring small fills.
- Removed avgCost overwrites from Data API/WS; avgCost is now recomputed from fills when inventory matches.

Data Flow Mapping (Phase 1)
On-Chain Fill Event → MarketMakerFill Record

Chain Event to Pending Fill: When an order is filled on-chain (via Polymarket’s smart contracts), the CLOB WebSocket feed or periodic poller detects the fill. The system records a pending fill event in the database (MarketMakerFillEvent with status "PENDING") capturing the order ID, price, and incremental size filled (the change in size_matched). Each event is uniquely identified by (orderId, matchedTotal) to avoid duplicates. This pending state acts as an intermediate buffer, ensuring we never drop a fill: even if not immediately confirmed, it’s logged for later reconciliation.

Pending Confirmation via Drift: The source of truth for filled quantities is on-chain position data. A separate sync process periodically fetches the wallet’s positions from the Polymarket Data API (which reflects on-chain token balances) and compares them to our DB. The difference (chain minus DB) per outcome (YES/NO) is treated as “drift.” If the drift exceeds a tolerance, it triggers confirmation of pending fills. For example, if the chain shows 10 more YES shares than our DB, we interpret that as a BUY fill of ~10 shares to confirm. The code uses confirmPendingFillsForMarketMaker to match these drifts against pending events. Each pending event’s size is either fully confirmed (status set to CONFIRMED) or partially confirmed (reducing the pending size) until the drift is accounted for. Confirming creates a final MarketMakerFill record (authoritative fill) and updates realized PnL for sells. Any pending events left unconfirmed beyond a TTL (15 minutes by default) are marked REJECTED with reason "ttl_expired".

Fill Record Finalization: Once confirmed, a MarketMakerFill holds the final fill details: outcome, side (BUY or SELL), price, size, value, and realizedPnl (if a SELL). At this point the fill is considered authoritative. The yesInventory/noInventory balances in MarketMaker are then adjusted to match on-chain positions, effectively finalizing the inventory change from the fill. The pending event has served its purpose and will not be double-counted (the unique key prevents duplicate confirmation). This flow guarantees that every on-chain fill eventually produces a confirmed DB fill record (no loss of data), even if confirmation is delayed.

Order Placement & Lifecycle (DB → CLOB → DB)

Order Creation: When the market maker places quotes, an order is sent via the Polymarket CLOB API. On a successful placement, the API returns an orderId, which we store in a new MarketMakerOrder record along with the parameters (outcome YES/NO, side BID/ASK, price, size). Each MarketMakerOrder is linked to a MarketMaker (one market’s strategy) and has a unique combination of (marketMakerId, outcome, side, tier) to support multiple quote levels. The status is implicitly “live” unless otherwise noted – we assume it’s active on the order book until we hear otherwise.

Order Matching (Partial/Full Fills): As trades occur against our orders, the CLOB will report updates. WebSocket order messages provide the current size_matched for an order. The code keeps track of the previous matched size (lastMatchedSize in our DB) and on each update, computes the delta. For example, if an order goes from 0 to 5 matched, that 5 is a new fill; if it then goes to 8, the delta 3 is another fill. Each such delta triggers a pending fill event record (as above) for the incremental fill. This design means partial fills are handled gracefully: we may have multiple MarketMakerFillEvent entries (with increasing matchedTotal) for one order as it fills in pieces.

Order Cancellation & Completion: If an order is canceled by our system or fully matched, it becomes terminal. The WebSocket or polling logic will detect statuses "CANCELLED" or "MATCHED", etc. Upon seeing a terminal status, the system deletes the MarketMakerOrder record (since it’s no longer active on the book). Before deletion, we ensure any remaining fill delta is processed. For example, in the polling routine, if an order comes back "not_found" or with status matched/cancelled and we haven’t processed all fills, we handle the fills then remove the order. Order deletion is always done after processing fills, so we don’t drop any fill events inadvertently. (Orphaned fill events referencing a deleted order are avoided by confirming them during the final sync as needed.)

CLOB Orderbook Sync: We treat the CLOB’s active orders list as the source of truth for what orders should exist in our DB. A periodic sync (syncOrders) compares fetchActiveOrders() from the API with our MarketMakerOrder records. Discrepancies trigger action: if an order exists in CLOB but not DB, we add it (or log it as an anomaly); if an order is in DB but missing from CLOB, it likely was filled or canceled – we remove it as stale. This keeps our order list aligned with reality. Notably, the CLOB API’s getOpenOrders returns all live orders in one call, and we currently assume it’s complete (no pagination needed for reasonable counts).

Position (Inventory) Flow (Chain → Data API → DB)

External Source of Position Data: Polymarket provides a Data API for positions, which we use to obtain the canonical wallet holdings for each outcome token. This API returns an array of positions with fields like size (number of YES or NO tokens held) and avgPrice (average cost of that position). We fetch positions by wallet address (using our funder/proxy wallet) with no threshold so even tiny holdings are returned. The Data API is effectively reading on-chain balances of the conditional tokens, so it reflects ground truth (assuming it’s up-to-date). Latency is low (usually near-real-time updates within seconds of a trade).

Database Inventory Update: Our DB stores the current position for each market in the MarketMaker record as yesInventory and noInventory. After fetching the latest chain positions, we update these fields to match exactly. This is done in every inventory sync or full sync cycle. For each market maker, we map its YES/NO token IDs and look up the chain position sizes. Any drift beyond a very tiny tolerance (0.0001 shares) triggers a DB update to set the inventory equal to the chain value. In practice, this means after each sync cycle, yesInventory and noInventory exactly equal the on-chain token balances (no accumulation of error). We also update avgYesCost/avgNoCost from the Data API’s avgPrice at the same time – however, this is problematic (see issues below) because the semantics of avgPrice differ from our internal cost basis.

Lifecycle of a Position: The position fields in MarketMaker start at 0. As our bot trades, these inventories move up and down. Buys increase one outcome’s inventory; sells decrease it (and may increase the opposite outcome if trades swap YES for NO, though typically a sell of YES just yields USDC, not NO tokens). External actions (manual trades or merges) also reflect here: if someone manually sells a position outside the bot, the chain position will drop and our next sync will update the DB downwards (and likely mark a drift event). In essence, we treat the chain as the ultimate ledger of positions and continuously converge the DB to it. Pending fill events feed into this by prompting the chain position to change, but even if we missed a fill event, the chain vs DB comparison would catch the discrepancy and correct the inventory on the next cycle.

Intermediate States: There are moments where the DB and chain might disagree (hence “drift”). Between the time a fill happens on-chain and the time our sync runs, yesInventory/noInventory could be stale. The pending fill mechanism covers this gap by holding provisional records of fills that are not yet reflected in DB inventory. The design assumption is that eventually (very soon after) the inventory will be corrected to include those fills. During normal operation, these periods are short. If everything works ideally, pending fills are confirmed in the next sync and the inventory is updated in the same cycle, so the divergence is resolved. In summary, the data can exist in three representations: (1) External truth (CLOB order state, on-chain positions), (2) Internal pending state (MarketMakerOrder and MarketMakerFillEvent records reflecting in-progress changes), and (3) Internal final state (MarketMaker, MarketMakerFill records reflecting settled truth). The goal is to ensure these ultimately all converge to the same values.

Relationships & Orphan Handling

The database schema is structured to maintain referential integrity between these pieces. Each MarketMaker (one per market) links to many orders, fill events, and fills. Deleting a MarketMaker will cascade delete those, but in normal operation we don’t delete MarketMakers – we only deactivate them. Orders, fills, and fill events reference their MarketMaker and are removed when not needed (orders on cancel, fill events on confirmation or expiry). Because we double-check external sources, it’s unlikely to have “ghost” records long term: e.g. if an order was canceled on Polymarket but our DB still had it, the hourly full sync would flag “ORDER_IN_DB_NOT_CLOB” and remove it. Similarly, if a fill happened but for some reason our system didn’t record it, the position drift would catch it and we’d log a “POSITION_DRIFT” issue and correct the inventory. One possible orphan scenario is a pending fill event that never confirms (due to a logic bug) – those will eventually hit the TTL and mark REJECTED, effectively orphaned from any fill, but they remain in the DB for audit. We should ensure these are rare or nonexistent in a correct system.

Semantic of fields from external sources: To avoid confusion, we explicitly note meanings:

CLOB API – provides orders (id, side, price, original_size, size_matched, status) and trades (fills). size_matched is cumulative; we interpret changes in it as new fills. Status “LIVE” means order still open, “MATCHED” means fully filled, “CANCELLED” means killed, etc.

Data API – provides positions per token: size is the current token balance, and avgPrice is Polymarket’s notion of average cost of that position. (Likely this avgPrice is weighted by how the position was acquired, possibly including any partial exits – essentially average entry price of the current holdings).

On-chain state – the actual ERC1155 token balances for YES/NO tokens in our wallet. The Data API is a reflection of this state. On-chain also has info about market resolution (which token is redeemable for $1 if resolved, etc.), but that is outside our current sync (except that if a market resolved, chain positions might disappear after redemption).

All these flows together ensure our system tracks the market maker’s orders and positions with multiple safety nets (WS events, frequent syncs, full hourly reconciliations). Next, we analyze where this system can fail or drift.

Failure Mode Catalog (Phase 2)

Despite the robust design, there are many ways inconsistency (“drift”) can creep in. Below we catalog all identified failure modes, organized by category:

Race Conditions & Concurrency

Concurrent Sync Jobs on Same Data: We run multiple jobs in parallel – the market-making job runs every 5s and a separate inventory sync runs every 10s. These can overlap in time (e.g. both triggered at the 10-second mark) because we only lock each job type individually. This means a market’s MarketMaker record could be read/updated by the MM job at the same time the inventory sync is also reading/updating it. Without proper row-level locking, one job’s updates (e.g. adjusting inventory or PnL) could be overwritten by the other. For example, the MM job might confirm a fill and update realizedPnl while the inventory sync concurrently overwrites realizedPnl or avgCost fields when copying from the Data API. Current handling: We have no explicit mutex across job types – this is a potential data race. The risk is partially mitigated by the short duration of tasks, but it’s still possible. A locking or sequencing mechanism is needed to guarantee atomic updates (discussed later).

Read vs Write Timing: If two sync processes read data simultaneously and then both write, the later write may override the earlier. For instance, the hourly full sync and the 10s inventory sync could both detect drift and issue an update – the second update might be operating on stale assumptions if the first already changed the DB. Example: Full sync reads DB inventory (say 100 YES) and chain (100 YES). Meanwhile an external trade happens adding 10 YES. Inventory sync (running a bit later) reads DB 100, chain 110, and updates DB to 110. Then full sync proceeds to update (based on its earlier read) perhaps erroneously setting it back to 100 (if it didn’t re-fetch). In practice, our full sync does fetch fresh chain data during its execution, so this exact scenario might not occur; but overlapping cycles can still interfere. Current handling: The wrappers in index.ts try to skip a job if the previous same job is still running, but they don’t skip if different jobs overlap. There’s no cross-coordination, leaving this race open.

Fill During Chain Read: Consider the moment we fetch chain positions (Data API) and then use that to confirm pending fills. If a fill occurs after we fetched positions but before we write to DB, we have a problem. The new fill won’t be reflected in the chain data we just got, so no drift is detected; we’ll miss confirming that event in this cycle. Worse, we might overwrite the inventory with the old value. Example: We call getPositions(), chain returns YES=100. Immediately a new trade fills 10 YES (chain now 110). We then calculate drift (110 actual vs 100 known? but our data is stale at 100, so drift=0) and do nothing, leaving the pending event unconfirmed. The DB remains at 100. On the next sync, we’ll see drift of +10 and confirm it, but with delay. Current handling: No explicit mitigation; this is a timing window inherent to using slightly stale data. The impact is usually just delayed confirmation, but if multiple fills happen rapidly, we could always be one step behind (the so-called “catch-up problem”).

Order Cancel vs Fill Race: If an order is canceled (by us or externally) at the same time it gets filled, there’s a question of how we handle it. Suppose we send a cancel to CLOB, but before it executes, someone takes the remaining size. The CLOB might report the order as canceled (since we requested it), and we’d delete the order record, potentially ignoring the fill that happened moments before cancellation. Current handling: Our polling logic calls getOrder on each tracked order. If it returns “not_found” (which could mean fully matched or canceled), we do log an order stale event and delete it. But if fills happened just before cancellation, ideally getOrder would have size_matched > 0 which we process before deletion. There is a risk if an order goes terminal and we remove it before processing a late fill event. The code attempts to guard this by processing any sizeMatched difference first, then deleting if terminal. So this race is handled as long as the final getOrder sees the fill. If an order vanished entirely (no record from API), we might miss a fill – but the chain position drift would eventually reveal it as an “untracked increase”.

MM Job vs Inventory Sync updating same record: As noted, the MM job also performs an inventory check after quoting. We have a function syncInventoryFromChain inside the MM job that fetches chain positions and updates the MarketMaker record. Meanwhile, the separate inventory sync job does the same thing. Two processes could call confirmPendingFillsForMarketMaker for the same market simultaneously with slightly different drift calculations, or both could update the yesInventory field almost back-to-back. This could lead to double-confirmation of the same fill or other inconsistencies. Current handling: None specific – it’s reliant on chance scheduling. The design intent was likely that the inventory sync is “offset” 5 seconds from the MM job to not collide, but since 5s and 10s intervals do coincide at multiples of 10s, collisions do occur. We log any fill confirmation twice if it happened (though the second time might find no pending events to confirm). There’s a slight chance both attempt to confirm the same pending fill concurrently, which could insert duplicate MarketMakerFill records (though our unique key on events would throw an error). In short, it’s unsafe and needs serialization.

Timing & Ordering Issues

CLOB vs Data API Update Order: The CLOB (orderbook) and Data API (positions) might not update in sync. A fill could appear on the CLOB instantly (we get a WS trade message) while the Data API position might take a second or two to reflect the new token balance. In that gap, our system could record a pending fill (from CLOB) and then fetch chain positions that don’t yet show the change. As described, this results in the fill not confirming in that cycle. Symptom: Fill stays PENDING until next cycle when Data API catches up, or worst-case gets marked ttl_expired if Data API repeatedly lags. This ordering issue can cause temporary drift alarms. We have seen evidence of small fills not confirming (likely due to tolerance issues plus timing).

Data API before CLOB (out-of-band trade): Conversely, the Data API could show a position change that our system didn’t initiate via CLOB. For example, someone manually bought tokens on the market (outside our bot). Our Data API poll would show an increased position (drift) but there was no corresponding CLOB order fill event in our system. We’d correct the inventory (sudden jump), but have no MarketMakerFill record to explain it – effectively an “untracked fill”. The reconcile logic flags this as an increase with no tracked buy. This is expected for external interference (see external section), but it’s a timing/order issue in that our system only found out after the fact via chain data.

Events Out of Order: If events are delivered out of sequence (e.g., the WS feed might, in theory, give two trade messages in reverse order, or a cancel comes through after a fill), we could mis-handle them. For instance, if a partial fill of 5 and then another of 3 occurred, but we processed the 3 first, our logic might treat the 5 as a new fill (since it sees matchedTotal jump from 3 to 5, which looks like a 2 share decrease in matched, which our code isn’t expecting). In practice, the CLOB should not send out-of-order updates for a single order – matchedTotal should always increase monotonically and our system uses that assumption. But network delays could mean we poll the order status and handle a fill in the polling loop after the WS already did, etc. We have unique constraints to prevent double-processing, but out-of-order could lead to ignoring a fill or treating it as an error. We log a warning if a fill verification fails (one cause could be if we confirmed a later fill first, then when we go to confirm the earlier one, chain position no longer has the expected gap).

Latency / Frequency Limits: There’s an inherent delay between on-chain activity and our sync. The maximum latency is essentially the sync interval in the worst case: e.g. if a fill happened just after our 10s inventory sync, we might not confirm it for ~10 seconds (or up to an hour if somehow all quick syncs missed it). The Data API itself is usually updated within a block or two (a few seconds on Polygon), but it could lag under load. We don’t have explicit timestamps from Data API to measure staleness. Ordering assumptions: We assume within one cycle, chain data corresponds to at least the same or earlier events as any CLOB data we saw. If that assumption breaks (i.e., chain lags behind CLOB feed), our verification will mark the fill “not on chain yet” and just leave it pending.

Simultaneous Fills and Cancels Across Markets: If multiple markets fill at once, our system processes them sequentially. If the processing is too slow, some events might only confirm on the next cycle. This is more a performance/timing issue than ordering, but worth noting that heavy activity could stress the timeliness of our sync loops.

Partial Failure Scenarios

Crash After Recording Pending Fill: If our worker records a pending fill event and then crashes (or the process restarts) before confirmation, that event sits in the DB with status PENDING. On restart, the inventory sync will run and call confirm logic on it. If chain data still shows the drift, it will confirm normally on the next run (so we’re eventually consistent). The risk is minimal here – at worst a short delay in confirmation.

Crash After Confirming Fill but Before Inventory Update: This is more problematic. Suppose we confirm a pending fill (move it to CONFIRMED and create a MarketMakerFill record, maybe update realizedPnl) but then the process crashes before updating the MarketMaker’s inventory fields. The DB would now show a fill (meaning we think we bought/sold some shares) but the yesInventory/noInventory are not incremented. This inconsistency would persist until a sync job corrects it by pulling chain data. In the interim, calculations that rely on inventory (like skewing quotes or risk checks) might be using a wrong value. Current handling: There is no explicit transaction tying fill confirmation and inventory update together – they happen in separate steps. So a crash in between leaves the system in an inconsistent state until the next correction. We rely on the next full sync or inventory sync to catch it (it would see a drift equal to the fill size and correct the inventory). This is essentially eventual consistency but not atomic – a window where PnL or avgCost might be off (and indeed, we’ve seen reports of avgCost corruption likely due to such races).

DB Update Succeeds, External Action Fails: One scenario: we successfully mark an order as canceled in our DB (or delete it) but the cancel request to Polymarket fails or times out. Now the order is still live on the CLOB, but we’ve dropped it from tracking. This is dangerous – it could fill completely “in the wild” and we’d have no record. Our system would only discover it when the chain position changed or when the full sync finds an “order in CLOB not in DB.” Current handling: The data-integrity full sync explicitly checks for orders present in CLOB but missing in DB and logs them as issues. It can auto-add or cancel them depending on logic (likely it would treat it as a discrepancy to correct, possibly by re-adding or sending a cancel). However, during the window until that sync (could be up to an hour), the order could be filling. We do have some safeguards: the WS listener sees all orders/trades for our key, even if we deleted the DB record. The WS code maintains an in-memory map of token->market maker, so if an untracked order got a fill, would we catch it? Possibly not, because if we removed the MarketMakerOrder, the WS handling might not find a matching DB order to associate. This scenario is complex but highlights that operations that have side effects (like canceling on CLOB) need two-phase handling. Currently, we do the DB delete after confirmation from CLOB side in most cases, but a failure in between leaves an inconsistency.

External Fill Confirmed, Inventory Update Fails: Conversely, consider if we confirm a fill (so we update inventory) but then fail to record the fill event itself (e.g., DB write for MarketMakerFill failed). Then inventory is increased but there’s no fill record. Our P&L reconciliation would later complain that realizedPnl doesn’t match fills. Or if it was a buy fill, realizedPnl isn’t affected, but avgCost might be wrong because we didn’t record the cost. Current handling: This is unlikely if the DB is up, but if a DB error occurred at the wrong time, we could have such a mismatch. There’s no specific compensating action except the P&L verify job logging the discrepancy. We don’t currently re-derive missing fills.

Order Delete vs Cancel API Failure: We touched on this – if we issue a cancel via API and optimistically delete the order locally, and that API call fails or is never acknowledged, we might think the order is gone but it’s actually still out there. The system doesn’t explicitly roll back the delete on cancel failure. It likely logs an error. Later, full sync would find an extra CLOB order and either recreate it in DB or cancel it. So we’d eventually fix it, but it’s a risk window for drift.

Double Processing Fills: If a fill event is processed twice (e.g., WS and polling both record it), we could end up with duplicate MarketMakerFill entries or double-counted PnL. We try to prevent this with the unique key and by updating lastMatchedSize on orders, but a partial failure (e.g., WS recorded a pending event, then our app restarted before it updated lastMatchedSize, and then polling runs and sees the same delta) could attempt to record it again. The unique DB constraint on (orderId, matchedTotal) would throw an error, preventing a duplicate. If not handled, that error could cause a crash in the job. Our code does a findUnique check before inserting events, but that isn’t foolproof under concurrency. Current handling: Rely on DB constraint and the fact that one of WS or poll will usually do it first. A better approach would be to unify the fill processing to one source or make it truly idempotent.

Data Semantic Mismatches

Avg Price vs Avg Cost: The Polymarket Data API’s avgPrice for a position does not mean the same as our avgYesCost/avgNoCost. Our avg cost is meant to be the weighted average entry price of the current inventory, excluding realized PnL from closed portions. The Data API likely computes something like (total cost of current tokens / number of tokens). However, if some were acquired via different means (or if tokens were sold, their avgPrice might still reflect some accounting). We suspect the Data API’s avgPrice might reset when position goes to zero, or include effects of merging tokens. By blindly overwriting avgYesCost with avgPrice on each sync, we essentially import external semantics into our P&L calculation. This has led to avgCost “corruption” – e.g., our avg cost jumping to match Data API even if that includes fees or excludes certain costs. For correctness, we likely should compute avgCost from our fill history only. Currently, this mismatch is a significant issue.

Size vs Shares vs Contracts: We treat everything in “shares” which map 1:1 to Polymarket outcome tokens. There’s no confusion in code (we consistently use Decimal(18,6) for sizes). However, note Polymarket sometimes calls them “positions” or “contracts” – but it’s the same concept. One subtlety: 1 YES token + 1 NO token = 1 USDC if merged. Our system doesn’t explicitly track the combined value if both sides held, but that’s more a strategy issue than a data mismatch.

CLOB size_matched (cumulative) interpretation: We correctly interpret size_matched as cumulative fill. But if someone wasn’t careful, one might think it’s incremental. Our code carefully computes deltas (new fill = current matched - previous matched). If this were done incorrectly (e.g., forgetting to store lastMatchedSize), we’d over-record fills. Thankfully, we have lastMatchedSize on each order to remember the prior total, and we update it after processing. One issue: if an order’s lastMatchedSize didn’t persist (say the app crashed right after a fill event), on restart that field might still be old. The next poll could see a matchedTotal and compute a delta from the old value, possibly duplicating the last fill. This is mitigated by immediate DB updates of lastMatchedSize in the same cycle as recording the event.

Precision and Rounding: We use 6 decimal places for prices and up to 18,6 for sizes in DB. The on-chain tokens might effectively be 6 decimals too (since USDC is 6 and conditional tokens likely follow). Rounding differences between our calculations and Polymarket’s could cause tiny drifts. For instance, if we compute avg cost as 0.333333 and Polymarket has 0.333334, over many trades a small discrepancy might accumulate. We set drift tolerance for avgCost very low (0.0001), so even slight rounding differences trigger a “correction” of avgCost from the Data API. This could cause oscillation or noise – e.g., our avgCost could be toggled by insignificant amounts. There’s also tolerance on inventory drift (0.1 share). This 0.1 is relatively large; it means we allow up to 0.1 token difference without treating it as serious. But pending fill confirmation uses the same 0.1 as the threshold to decide a buy/sell was detected, leading to the issue that smaller differences don’t confirm fills (see Issues in Phase 3). So indeed a mismatch in tolerance (0.1 vs 0.0001 elsewhere) is a semantic inconsistency causing logic issues.

Shares vs Cash Accounting: Our system tracks inventory in shares and realizedPnl in USDC. One potential mismatch: Polymarket Data API provides cashPnl and percentPnl etc., but we ignore those. We calculate realizedPnl from sells relative to avgCost. If there were any differences in how fees or rebates are handled, our PnL might not line up exactly. Currently Polymarket fees are built into prices (no separate fee field in fills except maybe we set fee=0 by default). If Polymarket introduced fees and Data API accounted for them in avgPrice or PnL, we could diverge.

“Shares” vs “Outcome count”: If a market resolves, 1 YES = 1 USDC if YES wins (and NO becomes 0), or vice versa. If our bot held both YES and NO, the Data API might show a combined position value or mark them redeemable. We consider that external to trading (we’d likely close out before resolution). But it’s an area where semantics of inventory would change (post-resolution, inventory might drop to 0 as tokens are redeemed for cash).

External Interference

Manual Trades on Polymarket.com: If someone uses the same wallet to trade manually via the UI, they could buy or sell outcome tokens outside of our bot’s control. This directly changes on-chain balances. Our system would detect this as inventory drift – the DB says X, chain says X±Δ. The reconcile job’s analysis might label it likely “EXTERNAL_SALE” or “UNTRACKED_INCREASE” depending on direction. The immediate effect is our inventory sync will overwrite the DB to the new values (so we don’t drift for long), but we end up with a fill that wasn’t recorded. That violates our “never lose data” principle. Currently, we have no mechanism to record fills for external trades (since they don’t correspond to our orders). They will show up as unexplained PnL or position changes. This is a known limitation: external interference is basically treated as a special case drift that we cannot fully reconcile automatically (we log it for investigation). It requires either preventing external trades (not always possible) or at least alerting and possibly creating a dummy MarketMakerFill labeled as external to account for it.

Different Bot or Process on Same Wallet: Similar to manual UI trades, if another bot or a user uses the same API key/wallet, they might place orders we don’t know about or cancel ours. For example, a second process could cancel an order that our bot placed. Our bot would get a WS event that the order is canceled (so we would delete it), but if the second bot placed its own orders, those would appear in CLOB open orders. We might see them in fetchActiveOrders and be confused (order in CLOB not in DB). If that other bot also traded, we’d see weird fills that we didn’t initiate. Essentially, multiple actors on the same wallet break the assumption that we have full control. Current handling: We currently assume a monopoly on the wallet – the system isn’t designed for multi-actor. The data integrity checks would flag unknown orders (issue type UNKNOWN_TOKEN or similar) and likely fail to map them to a MarketMaker. The tokenMap in WS is built from our MarketMaker records, so an order on a token we track but not in our DB might still be recognized by token -> market mapping, but since no DB order, we might not record it properly. In short, external bots would cause major drift and require manual intervention.

Positions Merged (YES+NO → USDC): Polymarket allows users who hold equal YES and NO shares to redeem them for the collateral (USDC) before resolution. If someone (or theoretically our bot, though we don’t do it) merges positions, the on-chain result is both YES and NO token balances drop (to zero if fully merged) and USDC balance increases. Our Data API position would suddenly show 0 for both outcomes. Our DB, however, might have had some inventory. On sync, we’d set both yesInventory and noInventory to 0, logging a drift. The reconcile analyzer specifically checks if both YES and NO went to zero simultaneously – if so, it labels the cause likely “POSITION_MERGED”. We then know it wasn’t a normal sale (since a sale would reduce one side and increase USDC but the other side would already be 0 typically). Handling: We log this, but do we adjust PnL? Currently, merging isn’t recorded as a sale in our system, so realizedPnl wouldn’t update. Effectively the user got their money back, which is like closing the position at $1 price. We might need to treat a merge as selling both outcomes at $1 – but the system doesn’t do that automatically. It simply sees inventory drop to zero; we might leave avgCost and realizedPnl as-is (which could be wrong – if we had any profit or loss, it’s realized upon merge). This is an edge case that likely requires manual PnL adjustment.

Market Resolution: When a market resolves, one outcome becomes redeemable for $1 and the other becomes worthless. If our bot still holds a position at resolution, the chain position might not immediately change (you still hold tokens until you redeem them). The Data API might mark them as redeemable/mergeable. Our system doesn’t have a specific resolution handler in this context, except that we’d stop quoting before end (by minTimeToResolution setting). If resolution happens, presumably we’d see an external action when we redeem tokens. If not redeemed, it’s just a stuck position. In any case, resolution is effectively an external event that our trading system doesn’t auto-handle. The safe approach is to close out before resolution. If not, we’d likely see a big drift (position goes to 0 after redemption) and we’d record an “UNTRACKED_REDUCTION” or similar cause.

Open Orders at Resolution: If somehow an order remained open at resolution (maybe our bot paused but didn’t cancel orders), Polymarket’s backend would likely cancel those orders (since the market is over). They would appear as canceled in CLOB. Our next sync would remove them. Fills can’t occur after resolution because trading stops. So the main risk is just PnL from holding positions through resolution.

External Deposits/Withdrawals: Not directly mentioned, but if someone moved funds or tokens in/out of the wallet outside of trading (e.g., transferred YES tokens to another wallet), it would look like a drift as well. We handle that like an external trade – inventory changes with no corresponding fill (likely logged as “position disappeared” or “untracked increase”).

API Reliability & Consistency Issues

CLOB API Empty/Partial Results: If fetchActiveOrders() were to return an empty list erroneously (say the API fails to list orders), our full sync might interpret that as all orders gone. The code currently, in the market-making job, if openOrders comes back empty while we have orders in DB, logs a warning and skips fill reconciliation for safety. This prevents a mass deletion on a transient API glitch – a good safeguard. However, if the issue persisted (e.g., API consistently not returning an order), that order would remain in our DB without correction (until maybe a later success). In quickSync, if fetchActiveOrders fails (null), we mark a critical issue and do nothing. So an unavailable CLOB API essentially halts our sync of orders. There’s no retry logic in data-integrity (market-making job does have a retry mechanism with a circuit breaker for dependencies). If the API only returns a partial set of orders (unlikely unless pagination is a thing – but Polymarket’s getOpenOrders probably returns all), we might miss some. We do not explicitly handle pagination, assuming the set is small.

Data API Staleness: If the Data API lags or returns stale data (e.g., doesn’t include the latest block), we might not catch a recent fill. Our tolerance thresholds might then cause the fill to sit pending. If the Data API were significantly delayed or stuck, our system would accumulate pending events and not confirm them, potentially hitting TTL expiry. We count how many times Data API fails; after 3 failures we stop syncing (circuit open). If it’s returning data but stale, we have no direct detection. One clue could be if positions don’t change over time even though we saw fills – that would appear as verification failures (“fill not on chain”). We do log fill verification failures if a fill is not reflected on chain. So we might see a pattern of warnings “fill verification failed – expected chain >= X got Y” if Data API wasn’t updating.

API Timeout / Error Mid-Request: If an API call times out, we catch exceptions and treat it as null result. This triggers our failure counters. The inventory sync job could skip that cycle if Data API is unavailable (it logs and doesn’t update anything). That means any fills in that period won’t confirm (since confirmPendingFills is called only after getting positions). They remain pending longer. A long outage could lead to many pending fills all confirming at once when the API returns (or some expiring if TTL passes). Similarly, if CLOB API is down, we can’t sync orders or place/cancel. The MM job has dependency retry logic to avoid placing orders if openOrders or balance calls fail – it goes into degraded mode using cached data.

Inconsistent Data Between Calls: It’s possible (though rare) that within one cycle, different API calls return data from slightly different moments. E.g., we call fetchActiveOrders and then getPositions – if one reflects a new fill and the other doesn’t yet, we have a temporary inconsistency. Our code does fetchActiveOrders first, then getPositions, then does reconciliation. If an order fill came in that window, the openOrders might include an order with size already decremented, and positions not yet incremented. The result is the same issue: pending fill and no confirm. Another inconsistency could be the WebSocket vs REST: WebSocket might have already removed an order or given a fill, while our scheduled job still sees it in openOrders (if the WS event processing and job timing conflict). We double-handle via both WS and polling intentionally as redundancy, but it can lead to some overlap conditions (we rely on idempotency mechanisms to not double-count).

WS Subscription Gaps: If our WebSocket connection drops or lags, we might miss a fill event in real-time, and only catch it on the next poll. That creates a delay and possibly a confusing scenario where by the time we poll, the order might be gone (matched completely). We’d see order not found and a position drift. We handle it by logging and sync, but missing WS updates is effectively a partial failure we have to tolerate.

Polymarket API Specifics: We assume the Polymarket APIs are mostly reliable but note that Data API is a separate service – it could sometimes be slightly behind the on-chain state, especially if many trades happen in a short time. Also, the Data API limit parameter (we use 500) means if more than 500 positions exist, we’d truncate. Unlikely for one wallet to have >500 markets, but a theoretical edge case (we’d miss some positions above the limit). The code does set limit: 500 on position fetches, so if that ever isn’t enough, some small positions might not be returned (leading to “position missing” issues for those we didn’t get).

In sum, while the system has multiple layers of checks, these failure modes illustrate why drift can still occur – often due to timing, mismatched assumptions, or non-atomic processes. Many of the known drift incidents (inventory drift, avgCost issues, ttl_expired fills, PnL discrepancies) can be traced to some combination of these factors. Next, we audit specific parts of the implementation to pinpoint concrete bugs and weaknesses contributing to these problems.

Current Implementation Audit (Phase 3)

Below we review the key modules and files, summarizing any bugs, edge cases, race conditions, and providing recommendations for each:

apps/worker/src/lib/fill-events.ts

Pending Fill Tolerance Mismatch (Bug): The constant PENDING_FILL_TOLERANCE is 0.1 (10% of a share), meaning we require >0.1 difference in inventory to trigger a fill confirmation. However, elsewhere (inventory sync) we treat any drift >0.0001 as significant. This mismatch causes small fills (<0.1) to never be confirmed via confirmPendingFillsForMarketMaker, because the logic sets direction = null if drift is less than 0.1. Meanwhile, the inventory sync will still correct the inventory for a 0.05 fill (for example) by directly adjusting the DB, bypassing our confirmation. The result: the fill event stays PENDING until TTL expires (we’ve observed fills being marked "ttl_expired" in logs). Recommendation: Greatly lower the tolerance for confirming fills (e.g. 0.0001 or even 0) to catch all fills. Alternatively, make the tolerance proportional to order size if needed for noise, but 0.1 is too high. This one-line change would allow small fills to confirm properly instead of timing out.

TTL Expiry Handling: The TTL for pending fills is 15 minutes by default. The code rejects any pending event older than that with reason ttl_expired. This ensures we don’t keep stale pending events forever. One edge case: if a fill is partially confirmed (e.g., we confirmed 90% of it and left 10% as pending), the original event’s observedAt doesn’t change, so the remainder could expire even if the fill actually eventually completed. We might end up with a CONFIRMED fill for part and a REJECTED remainder. This isn’t necessarily wrong (it indicates we never saw the last bit confirm on-chain), but it could slightly under-record a fill. Recommendation: When doing partial confirmations, update the observedAt or manage TTL such that only truly lost events expire. Possibly treat any partial confirmation as evidence of a real fill and extend the TTL for the remainder.

Partial Fill Edge Cases: The logic for partial fills confirms as much as needed to account for drift and leaves the rest. It marks an event fully confirmed if confirmSize >= size - tolerance. One edge case: if the drift is only enough to confirm, say, 99% of the event, it will leave a sliver (<0.1 shares) as pending. That remainder might never confirm (below tolerance) and eventually expire. In effect, we’d under-count by that sliver. This is minor but could accumulate if many events get almost-but-not-fully confirmed. Recommendation: After confirming fills, if the remainder is below a tiny threshold (e.g. <0.001), just mark it confirmed (round it off). This would eliminate noise events.

Concurrency and Idempotency: recordPendingFillEvent first checks if an event with the same (orderId, matchedTotal) exists to avoid duplicates. However, this is not atomic – between the find and create, a duplicate insert could occur from parallel calls. We rely on the unique index in the DB to ultimately prevent it, but the code doesn’t catch the DB error if it happens. In theory, if the WS thread and the polling thread tried to insert the same event simultaneously, one would throw an error and propagate (possibly crashing that job’s execution). Recommendation: Use a transaction or handle the uniqueness error gracefully (catch and treat as duplicate). This is a rare race, but worth hardening.

No Inventory Update Here: Notice that confirmPendingFillsForMarketMaker updates realized PnL in-memory and in DB (for sells) and inserts fill records, but does not update yesInventory/noInventory. It assumes the caller will do that via a separate step (which inventory sync does). This separation is a design choice but can be unsafe if not coordinated (see atomicity issues under data-integrity). It means during the window after confirming fills and before inventory update, the DB is inconsistent. Recommendation: As part of a redesign, consider performing the inventory update at the same time as fill confirmation (possibly in the same transaction) to keep state consistent.

apps/worker/src/jobs/data-integrity.ts

This job handles full and quick sync of our DB with external truth (orders and positions). Key findings:

Overwriting avgYesCost/avgNoCost from Data API (Semantic Bug): In the position sync, after computing drifts, the code unconditionally sets avgYesCost = nextAvgYes (where nextAvgYes is the Data API’s avgPrice). This is done whenever there’s any drift >0.0001. The intent was to keep our avg cost aligned with Polymarket’s reported avg price, but this is semantically wrong for our P&L tracking. It effectively overrides our internal cost basis calculation on every sync. For example, if our bot bought YES at 0.5, then again at 0.6, our avgYesCost might be 0.55. If the Data API calculates avgPrice differently (say it shows 0.58 due to some rounding or because it calculates from current holdings only), we’d replace 0.55 with 0.58. This leads to drift in realizedPnl calculation (because when we sell, we compute PnL relative to avgYesCost). Essentially, we’re mixing two accounting systems. Recommendation: Stop overwriting avg cost from the Data API. Instead, maintain avg cost via our own fills. Only use Data API for inventory (size). If there’s a case where our avg cost might need reset (e.g., external merge or external buy we missed), we should handle that explicitly (maybe mark something for review) rather than blindly trust avgPrice.

Multiple Sync Sources (Race): Data-integrity full sync can run concurrently with the market-making job’s own sync logic. The full sync’s syncPositions does similar steps to syncInventoryFromChain in the MM job. There is potential for conflict as discussed. There is no locking in this file to prevent overlap (it relies on the outer scheduler which, as we saw, doesn’t coordinate across job types). This is not a bug in a single function, but a design issue: e.g., fullSync could correct something at the same time the MM job is also making changes. We’ve covered this in Phase 2. Recommendation: Possibly unify these syncs or have them communicate via flags (e.g., if fullSync is running, skip the inventory sync job, etc.). The code already prints that the hourly sync is now “alert-only” (perhaps they turned auto-correct off except when drift detected), but still, coordination is needed.

Order Sync Edge Cases: In syncOrders, the code fetches all open orders from CLOB and compares with our DB. If an order is found in CLOB but not DB, they add an issue “ORDER_IN_CLOB_NOT_DB” – but it’s not clear if they actually insert it or just log. For orders in DB not in CLOB, they likely remove them (or mark issues). One edge: orphan orders – if an order in DB has no corresponding MarketMaker (shouldn’t happen due to relations), or if a MarketMaker is inactive but orders still linger. The code sets aside unknown_token issues for any active CLOB order whose tokenId isn’t tracked. That covers the case of an order for a market we’re not tracking (maybe external). It logs but doesn’t auto-cancel them. Recommendation: Ensure that orders in DB not in CLOB are always removed if autoCorrect is true. And consider auto-cancelling orders that show up in CLOB not in DB (since that likely means our system lost track – perhaps safer to cancel them to avoid unmanaged risk).

Position Drift Thresholds: The data-integrity uses a drift threshold of 0.1 shares to decide severity (ERROR vs WARN), but will correct any drift >0.0001. This is fine, but we should note that 0.1 share (at $1) is a small $0.1 deviation; if our tolerances elsewhere are lower, we might want to lower this too so that any drift is considered serious. Right now, a drift of 0.05 wouldn’t even flag an issue (since both conditions in the if would be false) but we would still correct it silently. That might hide problems. Recommendation: Lower the threshold for logging WARN perhaps to 0.01 shares to catch smaller drifts explicitly, or log avgCost drift separately. Also log when avgCost alone drifts (currently if avg cost drifts >0.0001 it will log WARN).

P&L Verification: This job sums up all MarketMakerFill.realizedPnl and compares to MarketMaker.realizedPnl for each market. If there’s >0.01 difference, it logs a PNL_MISMATCH issue. This is good for detecting discrepancies. Currently, on finding a mismatch, it does not fix it, just logs. So if our avgCost overwrites have caused realizedPnl to drift, we’d see warnings but no correction. Recommendation: If the cause is known (e.g., floating point rounding), consider automatically correcting the stored realizedPnl to match the sum of fills (the sum of fills is the ground truth of realized PnL). However, if the mismatch is large, logging and manual investigation is warranted (which is what they do with severity levels).

Auto-Correct vs Log Only: The code distinguishes issues with an action field (CORRECTED, LOGGED, REQUIRES_MANUAL). For instance, position drift is marked CORRECTED (since we overwrite the DB), whereas PNL_MISMATCH is just LOGGED. We should review if some “LOGGED” issues could be safely auto-corrected. For example, an ORDER_MISMATCH (price or size different in DB vs CLOB) – currently they do update price/size if they differ by >0.0001. That’s a silent correction. ORDER_IN_DB_NOT_CLOB leads to deletion. These are auto-correct. But ORDER_IN_CLOB_NOT_DB is likely only logged (it might require manual, since it’s weird to see an untracked order). Possibly we could auto-ingest it (create a MarketMakerOrder) if it matches one of our markets, to immediately track any rogue order. Recommendation: Review each issue type – ensure that anything that can be fixed immediately is marked CORRECTED and done so. E.g., if an avgCost is off but inventory matches, maybe recalc avgCost from fills and correct it.

Crash handling: If fullSync throws an error mid-way, they catch it and log a CRITICAL ORPHAN_ORDER issue with stack trace. That’s a bit of an odd reuse of ORPHAN_ORDER type to log general failures. It might confuse the issue counting. Not a big deal, just an observation.

apps/worker/src/jobs/market-making.ts

This is the main market making loop which also includes fill checking and some reconciliation. Notable points:

checkAllFills completeness: This function polls every tracked order via getOrder to ensure we catch any fills we didn’t get via WS. It is designed to catch all fills, even if WS missed them. It also cleans up stale orders (not found). Based on the code, it does catch all normal scenarios:

It records new fills (previousMatched null or lower than sizeMatched).

It warns if an order disappeared without us seeing fills (treating it as fully filled or canceled).

It doesn’t double count because lastMatchedSize is updated after processing.
One limitation: It skips fill reconciliation entirely if the open orders list from CLOB is empty but we still have orders in DB (which usually means the CLOB didn’t return them due to an API glitch or temporary disconnect). In that case, it prints a warning and returns, leaving any potential fills unchecked until next cycle. This is cautious (to avoid mistakenly treating all orders as gone), but if the CLOB was indeed correct that no open orders, it means they were all filled/canceled – in which case we missed it. We rely on a later sync to catch those. Recommendation: If openOrders is empty but DB orders exist, perhaps immediately trigger a re-fetch (maybe the call failed silently). Or mark those orders for aggressive checking next time. Currently it just tries again next cycle, which is fine as long as it was a transient issue.

verifyFillAgainstChain leniency: The fill verification logic allows a difference up to 0.5 shares between expected chain position and actual. This tolerance is relatively large (half a token). It might be set so high to avoid false negatives. But if a fill is smaller than 0.5, this will nearly always verify as true even if the chain didn’t update (since expectedPosition - chainPosition might be smaller than 0.5). That means if the chain was missing a small fill (due to delay or failure), we wouldn’t catch it – we’d record the fill anyway. On the flip side, if a fill is legitimately on-chain, it’s unlikely chainPosition will be off by >0.5 unless the data is stale. So we rarely trigger a verification failure except in blatant mismatches. We have seen warnings of “FILL VERIFICATION FAILED ... expected >=X got Y” in logs, indicating it does trigger occasionally. Perhaps only when a fill was entirely not present on chain (like a phantom fill event). Recommendation: Consider tightening this tolerance if feasible (maybe 0.1) to catch smaller discrepancies, and see why such discrepancies happen. But if Polymarket’s position updates are near-instant, 0.5 might be intentionally cautious to avoid false alerts.

Order Lifecycle Tracking: The MM job ensures that:

Dry-run orders (simulation mode) are removed from DB promptly.

Orders not found or terminal are removed.

Partial fills generate PARTIAL_FILL log entries for audit.

Cancel events generate ORDER_CANCELLED logs.
There might be a slight gap: when an order fully fills (MATCHED), the code currently treats it as terminal and deletes it. But do we log a FILL action anywhere? We log partial fills and cancellations, but a full fill (MATCHED) is handled in the same branch as cancel/expire (just logs "order ... matched after fills" or similar). We might not have a specific log entry of type "FILL" for a fully filled order. We do insert fill records of course. This is more of a logging completeness thing: maybe log a QuoteHistory "FILL" action when an order fully fills. Not critical.

Degraded Mode Behavior: The code uses cached data if dependencies fail (like using last known open orders if CLOB is down). Trading on stale data is risky – for instance, if openOrders API fails multiple times, they might keep quoting based on an old snapshot of orders (not knowing one filled). The dependency handling tries up to 3 attempts then opens a circuit for 30s where it will use cache. This is safer than stopping entirely, but it could result in quote duplication or overshooting inventory if a fill happened in the interim. The design logs warnings in this case. Recommendation: In degraded mode, perhaps pause new quote placements (or only cancel existing) to avoid compounding issues until data is live. At least ensure some reconciliation is done when the API comes back (they do with quickSync).

Inventory Sync Redundancy: The MM job calls syncInventoryFromChain at the end of each cycle to update inventory from chain. And we also have the separate inventory sync job. This duplication means in practice inventory is being synced extremely frequently (every 5s via MM job plus every 10s via separate job). That’s probably okay (the overhead is small), but it increases the chance of race conditions. If the MM job’s inventory sync runs just after the standalone one, it will find no drift (already corrected) and essentially do nothing, which is fine. But if they overlap, we covered the issues. Recommendation: Possibly disable the standalone inventory sync if the MM job is running regularly, or vice versa. One robust approach: let the MM job handle fills and orders, and a slower job handle any missed drift, but not simultaneously.

Gaps in Fill Handling: One scenario: If our bot was paused (no market-making) for a while and an order remained open and got partially filled, when we resume, lastMatchedSize in DB might be stale. The checkAllFills on next run will catch up (sizeMatched vs previous and record events). That seems handled. Another gap: If the WS was disconnected for a period, but our polling still ran, we’d catch fills via polling. If both were off (bot down), when we restart, we rely on comparing chain positions to DB to realize something happened while we were down (since there’d be no pending events recorded). The reconcile job might flag an untracked increase. There’s a gap in that we wouldn’t retroactively know about specific fill events during downtime – data lost. Only chain position and maybe total volume traded could hint at it. Recommendation: If needed, one could fetch historical trades from Polymarket for downtime (if API allows) to backfill, but that’s a heavy lift. Acceptable to just detect drift and move on.

apps/worker/src/jobs/reconcile.ts

This job appears to focus on analyzing drift causes and updating the separate positions table (for UI portfolio). The relevant part for us is the market maker inventory drift analysis:

analyzeDriftCause logic: It tries to determine why DB and chain inventories differ. It looks at recent fill records, tracked orders, and current active orders on CLOB to guess the reason:

If chain went to 0 while DB > 0 and we have recent SELL fills, assume we sold externally (“EXTERNAL_SALE”).

If both outcomes went to 0, likely a merge (“POSITION_MERGED”).

If chain < DB (we lost tokens), and recent sells roughly equal the drift, assume it’s just our sells not synced (“TRACKED_SELLS_NOT_SYNCED”).

If chain < DB and no matching sells, call it “UNTRACKED_REDUCTION” (maybe external sale or partial merge).

If chain > DB (we gained tokens), call it “UNTRACKED_INCREASE”.
This covers a lot of cases. It’s fairly well thought out.
One flaw: It fetches fetchActiveOrders() unconditionally to count active CLOB orders for that outcome. If CLOB API is down, this could delay or fail the reconcile. Also, if drift is large, knowing active orders count might not add much insight (maybe to see if an open order could still fill). Not a big issue.

Logged vs Auto-Correct: The reconcile job, as written, does not fix anything – it logs the analysis results if drift exceeds a threshold (default 1 share). It purposely does not auto-correct; the idea is the hourly data-integrity sync would have already corrected by the time reconcile logs it. The threshold 1 share is relatively high; smaller drifts aren’t reported by this job at all. This was likely to avoid noise. But it means if we consistently have drifts of 0.5 shares that get corrected by inventory sync, reconcile will say “0 markets drifted” because none exceeded 1. So one might be lulled into thinking no issue while in reality 0.5 share drifts are happening frequently (which is not trivial given a share ~ $1). Recommendation: Lower INVENTORY_DRIFT_THRESHOLD or log all corrections somewhere. Perhaps tie it into the data-integrity process to flag whenever positionsCorrected > 0. The user specifically asked if drift threshold is appropriate – likely it should be lower (maybe 0.1) to catch issues earlier.

“Logged only” vs “auto-correct”: Right now, reconcile logs drift incidents for investigation, leaving the correction to data-integrity sync. Some issues (like repeated external interference) might warrant automatic actions – e.g., if likelyCause is EXTERNAL_SALE and it’s large, maybe temporarily pause the market maker or alert more loudly. But these are design decisions. For now, the separation is: data-integrity fixes straightforward mismatches, reconcile provides context. This is okay. Recommendation: Integrate reconcile analysis with data-integrity so that whenever a correction is made, we attach the likely cause analysis to the log. That way, every time we auto-fix, we know why (or at least a guess). This could be in logs or even stored for metrics.

Positions vs MarketMaker overlap: Note that this job also updates the separate Position and Trade models for open positions (non-bot context). That’s separate from market making, dealing with user portfolio view. It’s not directly tied to our drift issues except that it uses market prices for mark-to-market. No major audit needed there for this context.

packages/shared/src/polymarket/clob.ts

This is the Polymarket API client wrapper. Key functions: fetchActiveOrders, getPositions, placeOrder, etc.

fetchActiveOrders returns only live orders: It calls client.getOpenOrders() from Polymarket’s SDK and then maps the result to our CLOBOrder format. It sets each order’s status to "live" regardless (since by definition these are open orders). If the Polymarket API ever included partially filled orders in that list (it does), we handle it by using original_size || size_matched as the size field. That is a bit odd: we prefer original_size, but if not present, we use size_matched. Polymarket’s API might always provide original_size for open orders, though. If an order is partially filled, original_size remains the full size and size_matched is how much filled. Our MarketMakerOrder in DB tracks the original size, so that’s consistent. No bug here, just noting.

No Pagination Handling: We assume getOpenOrders returns all orders. If a user had, say, 1000 open orders (unlikely, Polymarket might limit or the bot logic would not place so many), we might need pagination. The SDK likely handles pagination internally or ensures all are returned. Given Polymarket’s typical usage, this is okay. Similarly, getPositions uses a limit parameter (default 100, we override to 500 in calls). If more than 500 position entries (i.e., markets with non-zero holdings) exist, the remainder would be cut off. That’s an edge case but theoretically possible if the bot trades >500 markets. Not a bug now, but keep in mind.

Error Handling: Both fetchActiveOrders and getPositions catch exceptions and return null on failure. Our upper-layer code checks for null and handles accordingly (usually by logging an issue or using cache). This is fine. However, when fetchActiveOrders fails and returns null, quickSync will immediately flag CLOB_UNAVAILABLE as CRITICAL and skip order checks. The hourly sync does a quickSync first and only if it sees ordersMatch false or positionsMatch false does it run fullSync. If the CLOB is down, quickSync sets ordersMatch=false, so they will run fullSync. FullSync’s syncOrders will also attempt fetchActiveOrders and likely find it still failing, log another error, and potentially exit early or skip order correction. There might be a bit of repetitive logging but nothing terribly wrong.

placeOrder logic: It has a dryRun mode and real mode. In real mode, it ensures allowances are set (calls updateBalanceAllowance etc.). It has retries for allowance. This is not directly related to drift, but note if placeOrder fails after we created a MarketMakerOrder in DB, we’d have a DB order with no corresponding CLOB order (the code currently creates the DB record after successful placement in MM job, so we’re safe – it doesn’t pre-create and then confirm). If a placement fails, we simply won’t insert the DB record.

getPositions data accuracy: The Data API’s response is taken as-is (an array of position objects). We assume those positions are correct. If the Data API had any quirks (like not listing a token if size=0, or rounding size), that affects us. For example, if size is extremely small (<1e-6), maybe it rounds down to 0 and omits it – then we’d potentially never correct a tiny dust position. We do set sizeThreshold=0, so ideally even dust shows up. We haven’t noticed issues here aside from the avgPrice semantic.

Proxy and Geoblock Handling: The clob.ts includes logic for proxies and geoblocking (Surfshark VPN use). If misconfigured, it might block API calls. But if that happened, we’d see continuous API failures (which would be obvious). Not really a code bug but an operational consideration.

In summary, clob.ts is mostly solid. The main improvement is being mindful of data limits and perhaps exposing more info (like if we wanted to use realizedPnl from Data API, which we likely won’t).

Database Schema (apps/web/prisma/schema.prisma)

Constraints and Indexes: The schema defines the necessary relations and some unique indexes. We saw:

MarketMaker.marketId is unique, ensuring one market maker per market.

MarketMakerOrder: unique on (marketMakerId, outcome, side, tier) and indexed by orderId. Potential missing index: We might want a unique constraint on orderId itself across all MarketMakerOrder. In theory, two market makers (different markets) could never have the same orderId, since Polymarket order IDs are likely globally unique UUIDs. So making orderId unique globally could add safety. Right now it’s just indexed, not unique. The risk of duplicate is low, but not impossible if we ever had multiple bots on same account (which we don’t).

MarketMakerFillEvent: unique on (orderId, matchedTotal), which is excellent for preventing duplicate events.

MarketMakerFill: no explicit unique composite keys (it’s fine, fills are uniquely identified by id; duplicates are avoided by how we insert).

All foreign keys have onDelete: Cascade or Restrict appropriately, avoiding orphan rows if a MarketMaker were removed (which normally won’t happen except maybe if we wipe a market’s data).

Non-null and Defaults: Most numeric fields have defaults of 0, meaning they’re non-null (e.g., realizedPnl, avgCosts default 0). This is good – we don’t have to worry about null checks in logic. One thing: realizedPnl is Decimal(18,6). If that number grows large (lots of trades, profit or loss), we have 18 digits and 6 decimals – that’s up to 999,999,999,999.999999. That’s one trillion, plenty of room for PnL in USDC. Should be fine.

Precision Sufficiency: Inventory and trade sizes are Decimal(18,6). Polymarket token has 6 decimals (I believe), so that matches. Value (price*size) is also stored in 18,6 which could go up to 1e12 as well if size and price are large – but price max is 0.99, size maybe at most a few million tokens if someone had huge inventory (not likely), so again safe. No overflow issues likely.

Nullable fields: Fields like lastMatchedSize in orders are Nullable, which is fine (null means no fill yet). confirmedAt in fill events is Nullable (not set until confirmed). All good.

Missing Foreign Key on orderId? One thought: We could have linked MarketMakerFill and FillEvent to MarketMakerOrder via orderId as a foreign key. But the schema doesn’t do that – they store orderId as a string. There’s no direct relation because orderId is not the primary key of MarketMakerOrder (and not unique globally as noted). If we made orderId unique, we could have had a relational link. Currently, to fetch all fills for an order, we have to query by orderId text match. This is minor and by design (Polymarket’s order ID is external, not our primary key). Recommendation: Consider adding an index on MarketMakerFill.orderId and FillEvent.orderId for query performance (if we ever need to find fills by order quickly). Not crucial if we always fetch fills via marketMaker relation.

No Check Constraints: Perhaps we could add some invariant constraints at DB level (like ensure avgYesCost >= 0, etc., but that’s not very useful beyond type domain). The business invariants (like yesInventory + noInventory should equal something) can’t be enforced via simple DB constraints.

Orphan scenario: The cascade delete ensures no orphan orders or fills if a MarketMaker is deleted. Orphan fill events might occur if an order is deleted but had pending fill events – however, since fill events link to MarketMaker, not directly to order, they wouldn’t be auto-deleted when the order is deleted. If we removed an order while it still had pending fill events, those events remain but now there’s no active order. They can still be confirmed by drift though, because we don’t strictly need the MarketMakerOrder record present to confirm (we just match by marketMakerId and outcome/side). But it’s messy. Ideally, we would not delete an order until its pending events are resolved. The code currently deletes orders immediately on terminal status, even if a fill event is still pending confirmation (usually we confirm them in the same cycle though). This could lead to an event with no corresponding order. It’s not harmful data-wise, but might complicate debugging. Recommendation: Possibly store orderId in fill records and events mainly for external reference, but consider linking fill events to orders (maybe by storing the MarketMakerOrder id as well) for easier traceability. Not strictly needed for correctness.

Overall, the DB schema is sound. Just a few enhancements (unique orderId, additional indexes) could be considered. The lack of locking is more on the application side than schema – we rely on transactions and unique constraints for correctness, which we have for fill events. We might consider adding a DB-level trigger or constraint to ensure MarketMakerFillEvents in PENDING status cannot exist if no corresponding MarketMakerOrder (but that’s complicated to enforce; better to handle in code).

To summarize known issues:

Avg cost overwrites and tolerance mismatch are concrete bugs causing drift.

Concurrency of syncs and non-atomic update sequences are design flaws leading to race conditions.

External events currently are handled in a detect-and-log manner, not prevented or fully accounted in our P&L (leading to drift that is corrected but not explained by fills).

The code already identifies these symptomatic issues (inventory drift, PnL mismatch, ttl_expired fills) in logs. Now, we proceed to define the ideal invariants and a hardened design to eliminate these problems.

Invariant Specification (Phase 4)

To guarantee perfect alignment between our DB and external truth, we define the following invariants that must always hold (or be restored very quickly, within one sync cycle). These cover inventory, orders, fills, and cost basis:

Inventory Invariants

Chain Inventory Match: For each market maker (market):
DB.yesInventory = (YES tokens held on-chain) and DB.noInventory = (NO tokens held on-chain), to within a negligible tolerance (e.g. 1e-6).
Explanation: Our recorded inventory must equal the actual on-chain balance of outcome tokens at all times (after any sync). If a divergence occurs (inventory drift), that’s a violation. We allow a tiny tolerance for rounding, but practically it should be exact since both are integers of 1e-6 precision.
Verification: Compare each MarketMaker.yesInventory and noInventory to an on-chain query or the Data API’s size. This is already done in sync (drift > 0.0001 triggers correction).
On Violation: Immediately correct the DB to match chain (chain is source of truth). If repeatedly violated (meaning something keeps causing drift), escalate (alert and pause trading on that market).

Inventory Conservation (Fill Accounting): Any change in inventory must be fully explained by recorded fills (or explicit external actions). Formally, over any time interval:
ΔyesInventory = Σ_BUY_yes(size) - Σ_SELL_yes(size) ± externalYesTransfers (and similarly for NO).
Where Σ_BUY_yes(size) is the sum of sizes of all BUY fills for YES recorded in MarketMakerFill, and Σ_SELL_yes(size) is sum of all SELL fills of YES, etc. External transfers (like merging or manual moves) are outside fills but would break this invariant unless we account for them separately.
Explanation: This means if yesInventory increased by 10, you must have a recorded BUY fill of 10 (or multiple that sum to 10) in MarketMakerFill. If inventory decreased, there should be SELL fills summing to that drop (or an external event flag).
Verification: One can compute net position change from fills: sum(BUY) - sum(SELL) for YES and compare to (currentInventory - previousInventory). Our system could enforce this per cycle or overall. It essentially holds if we never miss fills. External actions violate it, but then we flag those as external (so we might refine the invariant to exclude known external-caused changes). Ideally, if external merges/trades are disallowed, this invariant is absolute.
On Violation: This points to an unrecorded fill (or a double-counted one). The reconcile logic already tries to detect untracked increases/decreases. On finding, we should log an error and possibly create a “virtual fill” entry to correct history (or at least adjust realizedPnl if needed).

No Negative Inventory:
yesInventory >= 0 and noInventory >= 0 for all MarketMakers, always.
Explanation: You cannot hold negative tokens. Our DB default is 0 and we only add/subtract when buys or sells happen. A negative would mean we sold more than we ever bought (or a bug in merging logic).
Verification: Simple check on each update (practically enforced by using unsigned decimals). Could add a database constraint if decimals had that, but easier to just assert in code.
On Violation: This should not happen unless a serious bug; if it did, halt trading on that market and investigate – likely indicates we double-removed inventory or incorrectly handled merging.

YES+NO Merge Consistency: (If we allow merges) If yesInventory and noInventory both drop in tandem by X (and presumably USDC outside scope increases by X), mark that event as a merge. Invariant in that case: if both inventories go to zero simultaneously without recorded sells, it should correspond to an equal amount removed from both (yesDrop ≈ noDrop).
Explanation: This identifies merges/resolutions where both outcome tokens left the wallet.
Verification: The drift analyzer does this (if both sides zero and otherDbValue==0, likely merge). It’s more of a detection than a strict invariant to maintain, since merges are external. We just need to handle it properly.

Order Invariants

DB Orders reflect Actual Live Orders: Every MarketMakerOrder in our DB must correspond to an active order on the CLOB, unless it’s in the process of being canceled or was very recently filled. Conversely, every live order on CLOB for our wallet should have a corresponding MarketMakerOrder in DB.
Explanation: This ensures no “ghost” orders. If the DB says we have an order, it should be working on Polymarket. If Polymarket shows an order for us, we should be aware of it in DB.
Verification: Cross-check DB vs getOpenOrders() regularly. We do this in syncOrders (flag ORDER_IN_DB_NOT_CLOB and vice versa). Ideally, this check is continuous via WS as well (e.g., WS tells us about order creation and cancellation).
On Violation: Auto-remove orders that aren’t on CLOB (since they’re gone externally), and alert/cancel orders that are on CLOB but not in DB (since we didn’t place them via this process – possibly an external order using our key). Either add them to DB or cancel them to reconcile. Our current approach logs them; a hardened system might immediately cancel unexpected orders to prevent unknown behavior.

Monotonic Matched Size: For each order, lastMatchedSize should only ever increase (never decrease). It starts at null/0, and as fills happen, it goes up to original size then the order is done.
Verification: Every time we update lastMatchedSize, ensure new value >= old value. This is inherent in our logic (we never set it downwards), so invariant holds as long as code doesn’t bug. If we saw it decrease, that’d imply an impossible scenario (Polymarket doesn’t “un-fill” orders).
On Violation: Log error; likely a serious logic error or data type issue.

Order Lifecycle – no premature deletion: An order should not be removed from DB until all its associated fills are processed (recorded in MarketMakerFill). Concretely, if an order had any partial fills, those fill events should be confirmed before the order is deleted.
Verification: Check that for any MarketMakerOrder we delete, there are no PENDING MarketMakerFillEvents for that order. Possibly enforce by checking pending events count in the deletion logic. Our current code attempts to handle this by processing fills first, but let’s make it invariant.
On Violation: If an order was deleted with pending fills, those fills might become orphan. The system should ideally catch this on confirm (no order, but still confirm by marketMakerId). To be safe, we should never hit that – the invariant ensures the sequence is correct. If violated, it’s a code bug; the remedy might be to re-create an order entry or manually confirm fills.

Unique Order IDs: No duplicate Polymarket order IDs in active orders. (They should be globally unique anyway.)
Verification: DB constraint (could add unique index).
On Violation: It means two DB records refer to the same actual order – definitely wrong. Cancel one and merge data or investigate.

Fill Invariants

Every Confirmed Fill has a Chain Counterpart: For each MarketMakerFill (confirmed fill record), the corresponding change in on-chain position must have occurred. In other words, there should be an on-chain trade or outcome that accounts for those tokens and PnL.
Verification: This is hard to automate perfectly because it’s aggregate. But effectively our confirm logic ensures this by only confirming when chain positions change. Perhaps express it as: after each fill confirmation, yesInventory or noInventory changed by that fill size in the expected direction (which is true by how we do drift confirmation). We can also verify that the sum of all confirmed fills = total volume traded by this bot on that market (if we had an external source of trade data).
On Violation: If we find a fill that chain says never happened (e.g., chain position never changed), that indicates a phantom fill. Our verifyFillAgainstChain tries to prevent recording such a fill in the first place. But if one slipped through (perhaps chain data was wrong at the time), we’d later have an inventory drift opposite to that fill (inventory would be too high/low by that size). The invariant would be broken until corrected. The fix would likely be to mark that fill as erroneous (maybe remove it and adjust PnL).

No Duplicate Fill Records: A given actual fill should result in exactly one MarketMakerFill. We should never record the same fill twice.
Verification: Uniqueness by (orderId, matchedTotal) in events and by primary key in fills enforces this. Additionally, two fill records shouldn’t have the same filledAt timestamp + orderId combination ideally. Our unique constraint on events ensures we don’t double-confirm the same event.
On Violation: If duplicate fills are recorded, realizedPnl and inventory calc will be off (we’d think we sold twice as much, etc.). Our PnL verify and inventory drift checks would catch symptoms. The solution would be to deduplicate – e.g., identify the double and remove one. Designing the system to be idempotent avoids this in the first place (which we plan).

Realized PnL Consistency: MarketMaker.realizedPnl = sum of MarketMakerFill.realizedPnl for that market.
Explanation: The total realized profit/loss should equal the sum of PnL from each individual fill (sells typically). This is basically how we compute it, and our verifyPnL already asserts it within tolerance.
Verification: Every sync, recalc and compare. If any discrepancy (beyond a few cents), that’s a violation.
On Violation: Auto-correct by setting realizedPnl to the fill-sum (if we trust our fills). Or recalc the fills if we trust realizedPnl (less likely). In practice, fill-sum is the ground truth, so adjust the MarketMaker record.

Fill Price/Cost Validity: Each fill’s price should be between 0.01 and 0.99 (Polymarket bounds), and value = price * size (with rounding at 6 decimals). Also, for sells, the realizedPnl = (price - avgCostAtThatTime) * size. While we don’t store avgCost at fill time, realizedPnl recorded should reflect the correct difference.
Verification: We can recompute what the avgCost was at that time from prior fills and inventory and verify realizedPnl. That’s complex, but an invariant nonetheless: the sum of all buy costs minus sum of all sells (at avg cost) = current position * avgCost + realizedPnl. This is a fundamental accounting identity:
Accounting Identity: totalSpentOnBuys - totalReceivedFromSells = currentInventory * avgCost ± rounding. Rearranged: realizedPnl = totalReceivedFromSells - (sellSize * avgCost), which is how we compute each fill’s realizedPnl. Summing yields previous one. This invariant basically is another way to ensure no money is magically lost or gained.
On Violation: This would indicate an internal accounting bug. Our logs have not flagged major PnL mismatches except small rounding.

Cost Basis Invariants

Avg Cost Only Changes on Buys: The average cost for an outcome should only change when we buy more of that outcome (increasing position), and it should be the weighted average of the previous cost basis and the new fill. Selling should not change the avg cost of the remaining tokens (it simply realizes PnL).
Verification: Check logic each fill: if fill.side == BUY, then newAvgCost = (oldAvgCost * oldInventory + fill.price * fill.size) / (oldInventory + fill.size). If fill.side == SELL, then newAvgCost = oldAvgCost (or if position goes to zero, we can define avgCost=0 since no position). Confirm our code adheres to this: currently, confirmPendingFills doesn’t update avgCost at all – we update avgCost in inventory sync based on Data API, which is wrong. We want to instead derive it. So as invariant, after each fill confirmation, if it was a buy, we should update avgCost accordingly; if sell, leave it (or reset to 0 if position zero).
On Violation: If avgCost changes in a way not consistent with fills (e.g., external overwrite or error), we will miscompute PnL. To detect, we could simulate avgCost from the fill history and compare to stored avgCost periodically. If mismatch, recalc and correct avgCost.

Cost Basis vs Realized PnL: This is related to above identity. If we maintain:
totalCostBasis = yesInventory * avgYesCost + noInventory * avgNoCost (this is the total money spent on current holdings),
and track realizedPnl for what’s been closed out, then for a closed system (no external infusion), we should have:
initialCapital + externalInflow = totalCostBasis + realizedPnl + currentCash.
In our context, initialCapital is whatever USDC we started with (not explicitly tracked per market in DB, but could be inferred), and currentCash would be outside the MarketMaker record. This invariant basically ensures the books balance. It’s more for sanity than practical enforcement in code. But one simpler expression: if position is fully closed (inventory = 0), then totalCostBasis = 0 and avgCost resets, and all PnL should be realized. If inventory > 0, then some PnL is unrealized (which we don’t explicitly track, aside from marking to market in the separate Position model).
The invariant we enforce: No double counting of cost or PnL – i.e., once PnL is realized from a sale, that portion of cost is removed from avgCost calculation. Our fill accounting does that by not adjusting avgCost on sells and computing realizedPnl. So as long as that method is consistent, this invariant holds.

Non-Negative Cost Basis: avgCost should be >= 0 always (it can be 0 if we have no inventory, or if somehow got free tokens theoretically). Negative avgCost would imply we gained money per unit (not possible unless a rebate situation, which Polymarket doesn’t have).
Verification: trivial check.

AvgCost Reset on Zero Inventory: If inventory goes to 0, we should reset avgCost to 0 (since we have no position, there is no cost basis). Currently, our system might leave the last avgCost in place if not explicitly reset. For example, if we sold all YES, yesInventory=0 but avgYesCost might still show some number (from last buy). This isn’t actively harmful because we shouldn’t use avgCost when inventory is zero (or rather realizedPnl now accounts for all costs). But it’s cleaner to zero it out.
Recommendation: explicitly set avgCost to 0 when inventory hits 0 (the Data API likely does similar or just reports 0 size which we interpret as cost 0 next sync). This avoids confusion that might arise if we later buy again (though if we don’t reset, and then buy more, our formula should still handle it by weighting with oldInventory=0, giving new avg = fill price, so it’s fine mathematically).

Each invariant above is aimed at eliminating drift and ensuring consistency. If all were strictly enforced, drift should not occur except via external interference (which would be immediately flagged by an invariant breach, prompting correction). The key approach is to design the system so that these invariants are maintained in real-time or via transaction boundaries, not just eventually.

With these invariants in mind, we now propose a hardened architecture that would maintain them and eliminate the issues observed.

Hardened Architecture Proposal (Phase 5)

To guarantee correctness and eliminate drift, we propose a revamped architecture with the following core principles:

1. Single Source of Truth Strategy

Clearly delineate which component is the source of truth for each type of data, and ensure all updates respect that:

On-chain positions = single source for inventory. We treat on-chain (via Data API or direct calls) as the canonical source for token balances. Our DB’s inventory fields should always converge to that. However, to reduce constant drift corrections, we will update DB immediately upon known fills (since we know what on-chain will be after the fill). But the chain remains the authority to validate.

CLOB order state = single source for orders. The Polymarket order book (through their API/WS) is the authority on live orders and their statuses. Our DB of orders is a cache that we update based on API/WS events. We will not, for example, assume an order is canceled until the API confirms. We also won’t keep an order in DB if the API says it’s gone.

Our own records = source for PnL and avgCost. We do not trust external metrics for PnL or avg price; we compute these from our transaction history (fills). This means discontinuing use of Data API’s avgPrice in favor of internal calculation. The chain knows how many tokens we have, but how much we paid for them is our internal concern. By making our fill list authoritative for cost basis, we avoid semantic mismatch.

No silent overrides: any time we do overwrite something (like we did with avgCost), it should be based on a known event (like resetting after closing a position), not just because an external value differs. Essentially, trust the designated source and stick to it.

In practice, this means:

Inventory sync uses chain for size, but will compute what avgCost should be from internal data rather than taking chain’s avgPrice.

If an invariant is violated (e.g., internal avgCost doesn’t match external avgPrice by a wide margin), that triggers an investigation or at least an alert – it could hint at an external trade we missed. But we wouldn’t automatically replace our value; we’d treat chain’s info as hint to reconcile (maybe recompute avgCost from fills).

Chain is also the source for realized PnL only in the sense that ultimately all profit ends up as USDC on-chain. But we won’t try to reconcile realizedPnl with an external metric (since none provided); we just ensure our internal calc is consistent.

Conflict resolution: If we find conflicting information (like chain says we have tokens but we have no record of acquiring them), the strategy is:

Adjust the minimal set of fields to restore invariants. E.g., in that scenario, create a MarketMakerFill record labeled as external buy (or at least adjust inventory and perhaps avgCost accordingly). Or if chain shows fewer tokens than we think, treat it as an external sell and maybe realize PnL accordingly.

Essentially, either retroactively insert a synthetic fill or mark an external event such that our internal history accounts for the change. This way, chain and DB align and our PnL remains meaningful. Currently we just correct inventory without creating a fill record (leading to unexplained PnL changes). In a hardened design, we might introduce an “ExternalAdjustment” fill type or so to plug that gap. This preserves “never lose data” – we even capture external actions as data points.

2. Event Sourcing and Log of Truth

Adopt more event-sourcing principles: treat every fill and relevant action as an event in a log that can rebuild state:

Store raw events: Instead of relying solely on the current state fields (inventory, avgCost, realizedPnl), we maintain an append-only log of all fills (we already have MarketMakerFill events and final fills – that’s essentially our event log for trading activity). We might extend this to other events: e.g., an event for “manual adjustment” if we detect an external trade, an event for “market resolved” if applicable. With a complete event log, we could recompute the entire state from scratch if needed, which is useful for auditing.

Derive state from events: Invariants like inventory and PnL can be derived from the sum of events. We already do this for PnL verification. We could do it for inventory too (sum of buys minus sells events = current inventory, as an audit check). If any derived state doesn’t match stored state, there’s a bug.

Use events for debugging: If drift occurs, having the chronological event list (orders placed, fills confirmed, inventory corrections, external adjustments) will make it easier to pinpoint where something went off. Right now we log to console/DB, but an event table is more structured.

Potential Implementation: We already have MarketMakerFillEvent (pending log) and MarketMakerFill (confirmed fill log). We can continue with that but ensure every meaningful change is captured. For example, when we do an inventory correction due to external trade, instead of just adjusting inventory silently, we could log an event (perhaps as a special fill with side “BUY” or “SELL” and a metadata flag “external”) to represent that. That way, the event log explains how inventory got from A to B.

Benefit: This approach minimizes silent state changes. Everything is explicit. For instance, instead of just zeroing out inventory on a merge, log an event “MERGE: sold X YES and Y NO at $1”. Then the fills and PnL make sense (even if it wasn’t a real trade, we represent it as one for accounting).

Performance: Event sourcing can be heavy if we recalc state each time, but we don’t have to fully recalc on every run – we can still store state for speed, just ensure it’s consistent with events (like a ledger and a balance).

3. Idempotent, Deterministic Processing

Ensure that running any sync or processing step twice yields the same result as running it once, so that retries and overlaps don’t corrupt data:

Uniquely identify external events so we don’t process them twice. We already use (orderId, matchedTotal) for fills which is good. For other events, if we had an ID we’d use it. E.g., if Polymarket provided a trade ID, we’d log that. But they don’t, so matchedTotal is our surrogate. For inventory corrections (external), could key by a timestamp or sequence number if needed (ensuring we don’t apply the same external adjustment twice).

Use upserts or safe merges: When syncing orders, instead of deleting all and re-inserting (which could glitch if done repeatedly), do minimal diffs: add missing orders, cancel extra ones. Our current syncOrders does that logically (issues rather than blind reset).

Fill confirmation idempotency: Confirming pending fills is currently tricky if run twice: it could double insert fill records (except we guard by status change). If we accidentally called confirmPendingFillsForMarketMaker twice in quick succession with the same drift, the first call would mark events CONFIRMED and insert fills, the second call would find no PENDING events (or if in a race maybe tries partial update but count=0 so it skips). So it’s mostly idempotent by virtue of status changes. We should strengthen this: e.g., by doing confirmation in a transaction or by checking event status carefully, which we do. It’s okay now.

Avoid non-idempotent external calls: For example, if a job fails after partially executing, we might retry. Placing orders is not idempotent (you’d duplicate orders). Our design might incorporate idempotency keys for order placements (Polymarket doesn’t support client order IDs, but we generate our own clientOrderId in DB – we could perhaps use that to detect duplicates). But that’s advanced; in current scope, manual caution is needed (ensuring we don’t accidentally double place due to a retry).

Retry logic: Increase usage of safe retries where possible. The MM job’s dependency retry is good. We might implement similar for critical DB updates (though transactions cover that mostly). If something fails mid-process, it should be safe to run the whole sync again. Achieving full idempotence might require splitting tasks: e.g., confirm fills (idempotent), then separately adjust orders (idempotent), etc., where each can be retried without side effects.

Example change: Use transactions for grouped DB updates so that either everything happens or nothing does – thus a retry won’t find a half-done state. For instance, wrapping confirm fills + inventory update in one transaction (with serializable isolation) would make it safe to retry that whole transaction on failure, as it wouldn’t commit partial.

4. Atomicity and Consistency in Operations

Introduce more atomic transactions and perhaps row-level locking to avoid the race conditions:

Single transaction for fill confirmation + inventory update: When a new fill is observed, ideally we’d:

Insert the MarketMakerFill record,

Update realizedPnl (if sell),

Update yesInventory/noInventory (for buy or sell),

Update avgCost (for buy or zero-out on close).
All in one go. Either all succeed or none. This removes the window where we had confirmed fill but not updated inventory. We can achieve this by doing confirmation not in the inventory sync step after reading chain, but at the moment we detect the fill via WS/poll, using the fill’s own data to update inventory. In other words, shift to optimistic inventory updating: assume the fill is real (if verified) and update state immediately.

Use DB Locks or SELECT … FOR UPDATE: If we have to do separate steps (like our current design does confirm in one function and update in another), we could at least lock the row so that another process can’t interfere in between. E.g., when one job is updating MarketMaker’s inventory, lock that MarketMaker row until done. This could be done by wrapping in a transaction with a dummy select FOR UPDATE on that row. Since we use Prisma, we might need raw SQL or careful use of transactions.

Coordinate jobs: Ensure that the inventory sync job does not run concurrently with the fill-processing in the MM job. E.g., we could set a flag “fillsUpdating” to true at start of checkAllFills and release it after confirmPendingFills is done. The inventory sync would check this flag and wait or skip. Simpler: run these tasks sequentially in one job instead of two. Perhaps fold inventory sync into the MM job entirely (so it always happens after fill processing, within one thread).

Atomic cancel & delete: When canceling an order, do not delete the DB record until we get confirmation of cancel from the API. If the API confirms, then delete in same tick. If it fails, leave the order in DB (maybe mark it). Currently we do this implicitly (we only delete when we get a WS or poll telling us it’s canceled). That’s good.

Transactions on multi-table updates: If an operation touches multiple tables (e.g., deleting an order and inserting a fill for its remaining size), do in one transaction. Presently, the code flow doesn’t obviously have multi-table transactions (except what Prisma might do behind scenes if we call multiple updates in one function and use prisma.$transaction). We may incorporate explicit prisma.$transaction([...]) calls to group related writes.

Optimistic locking on MarketMaker: We could add a version number or timestamp to MarketMaker and check it on updates to detect concurrent modification. If an update fails because the row changed (Prisma can emulate this by comparing updatedAt etc.), then we know two processes collided. This might be overkill if we simply prevent concurrency, but it’s an extra safety.

5. Continuous Consistency Verification and Self-Healing

Instead of relying on periodic manual checks, bake invariant checks into the system:

Real-time invariant checks: After each operation (fill confirm, order cancel, etc.), assert the key invariants. For example, after confirming fills and updating inventory, assert yesInventory + noInventory matches total from chain (if chain data available) or that realizedPnl matches fill sum. If an assertion fails, immediately raise an alert or even throw an error to stop the process. “Fail loudly” as the principle says.

Scheduled full audits: We keep the hourly fullSync but could shorten it if needed, or run specific audits like PnL check more often. Possibly after each significant trade, verify PnL consistency (small overhead).

Automatic remediation: For known patterns of drift, let the system auto-correct instead of just log. We enumerated some:

If realizedPnl mismatch is purely from rounding, auto-adjust it.

If an order is found on CLOB not in DB, auto-add or cancel it (preferably cancel for safety).

If a pending fill is about to expire TTL, maybe proactively fetch chain data again or assume it’s external and convert it to a confirmed external fill instead of dropping it.

Alert on anomaly: If something violates invariants in a way we don’t expect (e.g., chain position dropped and we have no explanation), the system should halt trading on that market (to prevent further damage) and alert operators. This ties to “fail loudly.” Right now, we log warnings, but the bot continues. A hardened approach might disable quoting on a market where drift repeatedly happens until someone investigates (to avoid hemorrhaging money due to unknown issues).

Drift thresholds: We should set thresholds such that any drift beyond trivial (like >0.01 token or >$0.01 PnL) triggers some correction or alert. The user asked minimum changes to guarantee no drift: basically tightening thresholds to zero and acting immediately, but we must consider noise. However, with improved logic, drift should rarely occur, so thresholds can be tighter.

Consistency between subsystems: We also have a “positions” table for user positions and a “MarketMaker” for bot. We should ensure they don’t diverge if they’re meant to reflect same underlying holdings (though likely separate: one tracks our internal strategy, the other tracks user portfolio). Just to note: the portfolio positions should also ideally reconcile with chain (which they do in reconcile job for markPrice, not for size since they use our DB’s size as truth for positions opened via the app).

6. Comprehensive Audit Trail and Debuggability

Enhance logging/audit so that any discrepancy can be traced:

Log each significant action with context: E.g., when confirming a fill, log which pending event (orderId, size) was confirmed and new inventory and PnL values. We have QuoteHistory and Log entries which partially do this (fills are logged as PARTIAL_FILL events with details). We can extend or standardize this logging.

Include external data in logs: For instance, when a drift is corrected, log what chain and DB values were and the likely cause from analyzeDriftCause. Right now, reconcile does it separately. We could integrate that so the log says “Corrected YES inventory from 100 to 110 (drift 10) – likely cause: UNTRACKED_INCREASE (external buy)”.

Store historical snapshots if needed: Perhaps keep an archive of MarketMaker state after each fullSync or each trading session, so we can see how it evolved. But if events are stored, we can always reconstruct snapshots, so events suffice.

Replayability: In a truly hardened system, if given the event log, one could replay all events and end up with the exact state as the DB. If not, there’s a bug. We should aim for that property. It provides a robust way to test the system (simulate a sequence of trades and see if final state matches expected).

Manual Intervention Tools: Provide ways to mark events as external or to adjust things with traceability. For example, an admin function to “record external sell of X shares at price Y” which would insert a MarketMakerFill (or a specialized event) and adjust PnL accordingly. This is safer than just editing the inventory in the DB, because it keeps the audit trail. So when invariants break due to something outside, we fix it by injecting an event, not by tweaking state under the table.

By implementing these design changes, we create a system where drift either cannot occur or is immediately corrected in a traceable manner. The chain and CLOB remain the ultimate references, but our system will mirror them in near real-time without the current gaps.

In short, the new architecture trusts each source of truth for what it’s best at, uses a single unified pipeline for updates to avoid races, and logs everything. Running this system, we should reach a point where the automated processes maintain alignment continuously and any deviation is either auto-fixed or loudly signaled.

Proposed Data Flow (New):

To cement the proposal, here’s how a fill would flow in the new design:

CLOB WS indicates order X’s matched size increased by Δ.

We verify against chain (small tolerance). If verified (or even if chain data not instantly available but we trust the event), we proceed.

In one atomic transaction:

Insert a MarketMakerFill record for that Δ (with price, side).

Update the MarketMaker’s inventory fields (yesInventory/noInventory) by ±Δ accordingly.

Update avgCost if it’s a buy (new weighted average) or if sell resulted in inventory 0 (reset that side’s avgCost to 0).

Update realizedPnl if it’s a sell (increment by (price - avgCost) * Δ).

Mark any corresponding pending event record as confirmed (or we could skip the pending record entirely in WS path and directly confirm).

Commit. Now the DB is fully up-to-date with the fill.

Later, the inventory sync runs, fetches chain positions. Ideally, because we updated immediately, there is no drift – chain and DB match. So it finds nothing to correct. (If there is a discrepancy, perhaps due to slight fee or something, it’s small and we handle it.)

The fill is logged and accounted. No pending state lingers; no drift to correct.

For external events (no WS because we didn’t place an order):

The chain sync notices a drift (say YES +10). It can’t tie it to an order. The new process: create a dummy fill event: treat it as if an external BUY happened at current market price or unknown price. We might use Data API avgPrice as a proxy for cost or mark it specially. Insert that as a fill (or adjustment event). This increases inventory by 10 and possibly affects avgCost. Now DB matches chain and we have an event logged as “external adjustment”.

Alternatively, one could not create a fill but just adjust inventory. But that breaks invariant of event-sourcing. So better to log something.

With these changes, the only drift that would require correction is from truly external interference, and even that we’d handle by creating an event so it’s not “drift” anymore but a recorded change.

7. (Optional) Monitoring & Alerts

Add monitors for when invariants are repeatedly broken:

E.g., if we see position drift corrected for the same market 3 times in an hour (indicating something consistently off), send high-severity alert.

If any critical invariant (like negative inventory or major PnL discrepancy) occurs, halt and page immediately.

Use the logging of likely causes to direct the response (e.g., “external sale detected – maybe user intervention needed to stop external trades”).

This isn’t directly asked for, but it aligns with “fail loudly” principle.

Finally, we outline an implementation roadmap to achieve this hardened design.

Implementation Roadmap (Phase 5 Deliverable)

To implement the above fixes and improvements, we suggest the following phased approach, focusing first on quick wins to stop the bleeding, then medium-term architectural changes, and finally long-term redesign aspects:

Immediate Quick Wins (Phase 1 – Quick Hardening)

Align Pending Fill Tolerance: Change PENDING_FILL_TOLERANCE from 0.1 to 0.0001 (or even 0) to ensure small fills confirm. This will prevent fills from languishing unconfirmed and being marked ttl_expired. (Expected outcome: No more pending fill expirations; every fill event gets confirmed on the next chain sync.)

Stop Overwriting Avg Cost from Data API: Remove or modify the lines in syncPositions that set avgYesCost = nextAvgYes and avgNoCost = nextAvgNo. Instead, keep our existing avgCost unless we explicitly detect a scenario warranting reset. We might initially simply comment out those assignments. (Expected outcome: avgYesCost/avgNoCost will remain what our fills dictate, eliminating the “cost basis corruption” issue where Data API semantics differ.)

Reset AvgCost on Zero Inventory: After selling down an inventory to 0, explicitly set the avg cost to 0. This can be done in the fill confirmation logic: if remaining inventory == 0 for that outcome, update avgCost to 0. This prevents stale avg cost values sticking around. (Outcome: MarketMaker.avgYesCost or avgNoCost becomes 0 when you hold no tokens, avoiding confusion on next trade.)

Tighten Drift Thresholds for Alerts: Lower the INVENTORY_DRIFT_THRESHOLD in reconcile from 1 to, say, 0.1 or 0.01 shares. Also consider logging even small drifts as INFO. This ensures we notice any drift that does occur. (Outcome: Better visibility into minor drifts that currently go unreported.)

Unique Index on Order ID: Add a unique constraint to MarketMakerOrder.orderId. This is a schema migration but quick. It ensures we never accidentally insert the same order twice. (Outcome: DB will prevent duplicate order entries if our logic ever glitches.)

Index fills by orderId: (If query patterns suggest) add an index on MarketMakerFill.orderId to speed up any lookups by order, and same for fillEvents. Not crucial but easy. (Outcome: Slight performance gain in investigating specific orders’ fills.)

Improve Logging Messages: Add logging for any instance of drift correction inside syncPositions: e.g., “Corrected inventory: YES from X to Y, NO from A to B, avgCost from C to D”. We have issues array, but a direct console or log entry helps. Also log when a pending fill is confirmed or rejected (currently, we increment metrics but don’t always log each confirmation explicitly). (Outcome: Easier debugging in logs – you see exactly when a fill was confirmed and when inventories were changed.)

These quick wins address the known glaring issues (small fills, avgCost overrides) and improve transparency. They can likely be deployed as a minor version update.

Medium-Term Improvements (Phase 2 – Structural Fixes)

Atomic Fill Confirmation & Inventory Update: Refactor the fill handling so that when a fill is detected (in WS or poll), we update the inventory in the same function/transaction. For example, extend recordPendingFillEvent or create a new function that not only inserts the pending event but also, if we have chain confirmation (or trust the event), immediately calls a mini confirm routine. Alternatively, modify confirmPendingFillsForMarketMaker to accept an option to also update inventory (currently it relies on the caller to do it). Implement prisma.$transaction to wrap the insert into MarketMakerFill and the update to MarketMaker in one go. (Outcome: Eliminates the window where fill is recorded but inventory not updated. Inventory is correct almost immediately after a fill.)

Serialize Inventory Sync vs MM Job: Ensure the standalone inventory sync job cannot run concurrently with the market-making job. Easiest way: in runMarketMakingJobWrapper, after finishing, manually trigger syncInventoryFromChain instead of having a separate cron, effectively merging them. Or use a shared locking mechanism (even a simple boolean as in index.ts, but a combined one). Removing parallelism simplifies reasoning. (Outcome: No more race conditions between two jobs writing to the same MarketMaker. All inventory adjustments happen in one thread.)

Consistent Use of Transactions: Audit all places where multiple DB writes happen in sequence. Wrap them in a transaction where failure of one should cancel all. Specifically:

In fill confirmation: updating event status, inserting fill, updating PnL and inventory – do together.

In order cleanup: deleting an order and logging a quoteHistory or whatever – do together if possible.

In fullSync: potentially wrap each market’s corrections in a transaction (so if one fails, it doesn’t half-update a market).
Use Prisma’s transaction API. (Outcome: If something goes wrong mid-process, we don’t end up half applied; we either roll back or succeed atomic.)

Recompute AvgCost from Fills on Demand: Implement a helper to recompute avgYesCost/avgNoCost from the fill history (for current open position) and use it in the full sync as a check. For instance, after syncing positions, calculate what avg cost should be: take all MarketMakerFill where outcome=YES, side=BUY that are still part of the open position (not sold yet), compute weighted average. Compare to DB.avgYesCost. If difference is significant, log and optionally correct. This addresses any residual drift in avgCost. We might not run this every time, but could in fullSync or on suspicion of error. (Outcome: Even if something went wrong in cost tracking, we can fix it occasionally so it doesn’t accumulate.)

Auto-Handle Order Discrepancies: Enhance syncOrders to automatically resolve certain issues:

If ORDER_IN_CLOB_NOT_DB and it matches a known market (tokenId maps to one of our MarketMaker), assume we missed creating it and do one of: either add it to DB (so we start tracking it) or cancel it on the CLOB. Probably safer to cancel if we truly didn’t intend it (which would be the case for an external order). If we suspect it’s an order we placed but failed to save, adding might be okay. Perhaps use metadata: if maker_address == our address (always true) and we find it in openOrders but not DB, it’s suspicious. Logging is not enough; issue a cancel through API for safety (with a warning).

If ORDER_IN_DB_NOT_CLOB, and autoCorrect is true, we already delete it. Just ensure we also create a QuoteHistory log for record.
(Outcome: No ghost orders lingering; any order out-of-sync is actively resolved, not just noted.)

External Fill Recognition: When we detect a positive drift with no pending fill (meaning an external buy occurred), create a synthetic MarketMakerFill to account for it. Perhaps label it differently (we could add a boolean or type field to MarketMakerFill like external: true). For calculation, treat it as a buy at avgPrice (since that’s the best info we have). Update avgCost accordingly. This way realizedPnl remains consistent (no immediate PnL since it’s a buy). Similarly for external sells: if chain position dropped and we have no fill, create a synthetic sell fill at the avgCost (effectively booking a PnL of (avgCost - avgCost)*size = 0? Actually, external sell likely at some price; we might approximate it or assume break-even for minimal PnL impact, or better, use price from Data API curPrice). This is complex to get exactly, but even recording it at avgCost would at least remove the inventory and not impact PnL (meaning we assume they sold at cost basis, so we don’t count a PnL – the actual PnL from an external action would then not reflect in our system, but at least inventory aligns). Alternatively, mark it and alert manual PnL reconciliation.
Start perhaps with a simpler approach: if external trade detected, adjust inventory and reset avgCost (if it was a full exit) or leave avgCost (if entry added) – our current approach – but explicitly log it as external. Over time, refine to actually record it as fill.
(Outcome: External interference no longer silently messes up PnL – we either assume zero PnL or approximate, but don’t let it skew avgCost incorrectly. The invariant of fill accounting is preserved by including an entry for these events.)

Locking at DB Level (if needed): If we still face concurrency issues, consider adding an explicit lock row or using advisory locks. For example, each MarketMaker could have a field “lockVersion” we increment on each update to detect overlaps. If two processes try to update same record with same version, one fails. Then we retry one. This is more complex and may not be needed if we serialize properly. Keep in toolbox if issues persist.

Better Handling of Partial Fills & Deletion: When deleting an order that was fully matched, ensure all its fills have been recorded. In checkAllFills, we already do that. We can add an assertion: if sizeMatched == originalSize, then the sum of fills recorded for that order equals originalSize (plus tolerance). If not, we missed something. Possibly log or re-fetch trades if possible. Not easy with current API, so mainly log if it happens. Usually should not.

The medium-term changes require more testing as they change how we process data fundamentally (e.g., making fill processing atomic and merging jobs). We’d implement these in a series of deployments:

First deploy atomic fill updates and removal of separate inventory job (these are internal changes that should reduce drift).

Next deploy external event handling improvements once well tested (we want to be careful creating synthetic fills).

Long-Term Improvements (Phase 3 – Full Rethink & Enhancements)

Unified Event-Driven Architecture: Move towards an architecture where the chain and CLOB events drive updates in real-time, with the periodic jobs as safety nets rather than primary mechanisms. E.g., use the WebSocket not only for fills but also consider listening to on-chain events (if Polymarket has an event stream or we could subscribe to the contract for Transfer events to catch even external transfers to our wallet). That would be the ultimate source of truth for fills – we wouldn’t even need to call Data API frequently. This is a bigger project: integrating a Polygon node or service to get events. It would allow instant detection of external trades or merges (you’d see a Transfer of YES from our wallet to someone else = external sell, etc.).
(Outcome: Near real-time sync with on-chain, reducing reliance on pulling Data API and eliminating drift windows.)

Complete Event Sourcing & Recompute Capability: Expand our logging so that we could completely reconstruct state from events. This might mean adding events for capital deposits/withdrawals, transfers, etc., not just trades. Possibly integrate with the “Position” and “Trade” model we have for user tracking so that they align with market maker activity events as well. A unified view where every token movement is logged.

Incorporate Safe-Stop Mechanisms: Implement automatic halting of trading on anomalies: e.g., if realizedPnl mismatch above X or repeated drift, set MarketMaker.paused=true automatically for that market and send alert. This prevents the bot from continuing in a possibly broken state.

Testing with Simulated Failures: Set up simulations where we intentionally drop WS updates, or interject artificial delays, to test that the system still ends up consistent. Also test scenarios like partial fills happening while a cancel is in progress. The redesigned system should handle these gracefully (no lost fills, no stranded orders).

Review Precision and Rounding: Possibly increase decimal precision if needed (maybe not needed, 6 decimals is fine). Ensure all arithmetic (especially PnL) is done with high precision to avoid cumulative rounding error. Could consider storing PnL in base currency smallest units (like cents) to avoid decimals, but given 18,6 decimals, we’re fine.

UI/UX for External Factors: In the long run, if external interference is frequent, consider preventing it (like only use a dedicated wallet that no human trades on). Or present in the UI the occurrences of external adjustments so the user is aware of them.

Continuous Monitoring Infrastructure: As a long-term ops improvement, integrate with monitoring tools (Slack alerts on drift, etc., or a dashboard of current invariants status).

Perhaps Remove Pending Fill Mechanism: If our immediate inventory update on WS fill works reliably and we have chain events for backup, the concept of pending fill events might be overkill. We could drop MarketMakerFillEvent entirely and just directly record MarketMakerFill. The “pending” was mainly to handle the uncertainty until chain confirm. If we trust our multi-source verification, we might not need to keep them pending – we either confirm or don’t record at all. Alternatively, keep them as a buffer for ones we’re not sure about. We can simplify logic if we find pending adds more complexity than benefit in the new design.

Rationale: Removing pending events could simplify the system: no TTL, no separate confirm step. But we have to be confident we won’t record false fills. With chain subscription or a robust verify, we might achieve that.

Leverage Polymarket Enhancements: If Polymarket’s APIs improve (e.g., they might provide a unified endpoint for trades or an official way to get historical fills for our account), use that to cross-check our logs.

The long-term steps require more development and possibly infrastructure (running a blockchain listener). They ensure that even rare edge cases are covered and the system is resilient to any scenario.

Success Criteria Revisited: After implementing these changes, we expect:

Inventory drift should drop to essentially zero in normal operation (the only corrections would be in cases of external trades, which we would handle explicitly).

Avg cost will remain consistent with actual trade history (no sudden jumps from Data API).

Pending fill events either never expire or the whole pending concept is removed; every fill that occurs is properly logged as confirmed.

Realized PnL in DB always matches sum of fills (our periodic check will always pass).

If an invariant is violated, the system either has already corrected it or has paused, so no silent divergence continues.

Over time, as we gather metrics, we should see the number of issues found by full sync approach zero. The full sync can then truly be just a sanity check that rarely finds anything, rather than a band-aid fixing things frequently.

In conclusion, these changes move us from a reactive, multi-sync system (prone to races) to a more transactional, event-driven system where the truth is recorded as it happens and discrepancies are nipped in the bud. This should guarantee alignment between our DB and the chain/CLOB, fulfilling the mission of perfect data integrity.
