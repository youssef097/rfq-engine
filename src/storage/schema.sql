-- Durable whole-parlay execution schema. Monetary columns use SQLite INTEGER.

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS markets (
    id TEXT PRIMARY KEY NOT NULL,
    description TEXT NOT NULL,
    terms_hash TEXT NOT NULL,
    hip4_json TEXT NOT NULL DEFAULT '["null"]',
    trading_closes_at INTEGER NOT NULL CHECK(typeof(trading_closes_at) = 'integer' AND trading_closes_at >= 0),
    resolve_after INTEGER NOT NULL CHECK(typeof(resolve_after) = 'integer' AND resolve_after >= trading_closes_at),
    dispute_period INTEGER NOT NULL CHECK(typeof(dispute_period) = 'integer' AND dispute_period >= 0),
    adjudication_period INTEGER NOT NULL CHECK(typeof(adjudication_period) = 'integer' AND adjudication_period > 0),
    fallback_at INTEGER NOT NULL CHECK(typeof(fallback_at) = 'integer' AND fallback_at >= resolve_after + dispute_period + adjudication_period),
    oracle TEXT NOT NULL,
    arbiter TEXT NOT NULL,
    halted INTEGER NOT NULL DEFAULT 0 CHECK(typeof(halted) = 'integer' AND halted IN (0, 1)),
    state TEXT NOT NULL DEFAULT 'UNRESOLVED' CHECK(state IN ('UNRESOLVED', 'PROPOSED', 'DISPUTED', 'FINAL')),
    proposed_result TEXT CHECK(proposed_result IN ('YES', 'NO', 'VOID')),
    challenge_deadline INTEGER CHECK(challenge_deadline IS NULL OR (typeof(challenge_deadline) = 'integer' AND challenge_deadline >= 0 AND challenge_deadline + adjudication_period <= fallback_at)),
    final_result TEXT CHECK(final_result IN ('YES', 'NO', 'VOID')),
    evidence TEXT,
    CHECK((state = 'UNRESOLVED' AND proposed_result IS NULL AND challenge_deadline IS NULL AND final_result IS NULL)
       OR (state IN ('PROPOSED', 'DISPUTED') AND proposed_result IS NOT NULL AND challenge_deadline IS NOT NULL AND final_result IS NULL)
       OR (state = 'FINAL' AND final_result IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY NOT NULL,
    taker TEXT NOT NULL,
    nonce TEXT NOT NULL,
    terms_hash TEXT NOT NULL,
    stake INTEGER NOT NULL CHECK(typeof(stake) = 'integer' AND stake > 0 AND stake <= 9000000000000000),
    response_deadline INTEGER NOT NULL CHECK(typeof(response_deadline) = 'integer' AND response_deadline >= 0),
    acceptance_deadline INTEGER NOT NULL CHECK(typeof(acceptance_deadline) = 'integer' AND acceptance_deadline > response_deadline),
    state TEXT NOT NULL CHECK(state IN ('COLLECTING', 'OFFERED', 'FILLED', 'SETTLED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
    selected_quote_id TEXT REFERENCES quotes(id),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0 AND created_at < response_deadline),
    reason TEXT,
    UNIQUE(taker, nonce),
    CHECK((state = 'COLLECTING' AND selected_quote_id IS NULL)
       OR (state IN ('OFFERED', 'FILLED', 'SETTLED') AND selected_quote_id IS NOT NULL)
       OR state IN ('REJECTED', 'EXPIRED', 'CANCELLED'))
);

CREATE TABLE IF NOT EXISTS request_legs (
    request_id TEXT NOT NULL REFERENCES requests(id),
    leg_index INTEGER NOT NULL CHECK(typeof(leg_index) = 'integer' AND leg_index BETWEEN 0 AND 7),
    market_id TEXT NOT NULL REFERENCES markets(id),
    side TEXT NOT NULL CHECK(side IN ('YES', 'NO')),
    market_terms_hash TEXT NOT NULL,
    PRIMARY KEY(request_id, leg_index),
    UNIQUE(request_id, market_id)
);

CREATE TABLE IF NOT EXISTS quotes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    request_id TEXT NOT NULL REFERENCES requests(id),
    maker TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    replaces_quote_id TEXT UNIQUE REFERENCES quotes(id) CHECK(replaces_quote_id IS NULL OR replaces_quote_id != id),
    payout INTEGER NOT NULL CHECK(typeof(payout) = 'integer' AND payout > 0 AND payout <= 9000000000000000),
    price_e6 INTEGER NOT NULL CHECK(typeof(price_e6) = 'integer' AND price_e6 BETWEEN 0 AND 1000000),
    expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at >= 0),
    state TEXT NOT NULL CHECK(state IN ('LIVE', 'SELECTED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0 AND expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_maker_quote
    ON quotes(request_id, maker) WHERE state IN ('LIVE', 'SELECTED');

CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY NOT NULL,
    request_id TEXT UNIQUE NOT NULL REFERENCES requests(id),
    quote_id TEXT UNIQUE NOT NULL REFERENCES quotes(id),
    taker TEXT NOT NULL,
    maker TEXT NOT NULL,
    stake INTEGER NOT NULL CHECK(typeof(stake) = 'integer' AND stake > 0 AND stake <= 9000000000000000),
    maker_collateral INTEGER NOT NULL CHECK(typeof(maker_collateral) = 'integer' AND maker_collateral > 0 AND maker_collateral <= 9000000000000000),
    payout INTEGER NOT NULL CHECK(typeof(payout) = 'integer' AND payout = stake + maker_collateral AND payout <= 9000000000000000),
    state TEXT NOT NULL CHECK(state IN ('OPEN', 'WON', 'LOST', 'VOID')),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    settled_at INTEGER CHECK(settled_at IS NULL OR (typeof(settled_at) = 'integer' AND settled_at >= created_at)),
    CHECK((state = 'OPEN' AND settled_at IS NULL) OR (state != 'OPEN' AND settled_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS position_legs (
    position_id TEXT NOT NULL REFERENCES positions(id),
    leg_index INTEGER NOT NULL CHECK(typeof(leg_index) = 'integer' AND leg_index BETWEEN 0 AND 7),
    market_id TEXT NOT NULL REFERENCES markets(id),
    side TEXT NOT NULL CHECK(side IN ('YES', 'NO')),
    market_terms_hash TEXT NOT NULL,
    PRIMARY KEY(position_id, leg_index),
    UNIQUE(position_id, market_id)
);

CREATE TABLE IF NOT EXISTS balances (
    account TEXT PRIMARY KEY NOT NULL CHECK(account != 'EXTERNAL'),
    amount INTEGER NOT NULL CHECK(typeof(amount) = 'integer' AND amount >= 0 AND amount <= 9000000000000000)
);

CREATE TABLE IF NOT EXISTS journal (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    destination TEXT NOT NULL CHECK(destination != 'EXTERNAL'),
    amount INTEGER NOT NULL CHECK(typeof(amount) = 'integer' AND amount > 0 AND amount <= 9000000000000000),
    reason TEXT NOT NULL,
    reference TEXT NOT NULL,
    CHECK(source != destination)
);

CREATE TABLE IF NOT EXISTS commands (
    actor TEXT NOT NULL,
    command_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    PRIMARY KEY(actor, command_id)
);

CREATE TABLE IF NOT EXISTS events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
    kind TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS requests_state_deadline ON requests(state, acceptance_deadline, id);
CREATE INDEX IF NOT EXISTS requests_taker_state ON requests(taker, state);
CREATE INDEX IF NOT EXISTS request_legs_market ON request_legs(market_id, request_id);
CREATE INDEX IF NOT EXISTS quotes_request_state ON quotes(request_id, state, sequence);
CREATE INDEX IF NOT EXISTS quotes_state_expiry ON quotes(state, expires_at, sequence);
CREATE INDEX IF NOT EXISTS positions_state ON positions(state, id);
CREATE INDEX IF NOT EXISTS position_legs_market ON position_legs(market_id, position_id);
CREATE INDEX IF NOT EXISTS markets_state_deadline ON markets(state, challenge_deadline, fallback_at, id);
CREATE INDEX IF NOT EXISTS journal_reference ON journal(reference, sequence);
CREATE INDEX IF NOT EXISTS events_aggregate ON events(kind, aggregate_id, sequence);

CREATE TRIGGER IF NOT EXISTS markets_immutable_terms
BEFORE UPDATE ON markets WHEN
    NEW.id IS NOT OLD.id OR NEW.description IS NOT OLD.description OR NEW.terms_hash IS NOT OLD.terms_hash
    OR NEW.hip4_json IS NOT OLD.hip4_json
    OR NEW.trading_closes_at IS NOT OLD.trading_closes_at OR NEW.resolve_after IS NOT OLD.resolve_after
    OR NEW.dispute_period IS NOT OLD.dispute_period OR NEW.adjudication_period IS NOT OLD.adjudication_period
    OR NEW.fallback_at IS NOT OLD.fallback_at
    OR NEW.oracle IS NOT OLD.oracle OR NEW.arbiter IS NOT OLD.arbiter
BEGIN SELECT RAISE(ABORT, 'immutable market terms'); END;

CREATE TRIGGER IF NOT EXISTS markets_monotonic_halt
BEFORE UPDATE ON markets WHEN NEW.halted < OLD.halted
BEGIN SELECT RAISE(ABORT, 'market halt is irreversible'); END;

CREATE TRIGGER IF NOT EXISTS markets_state_transition
BEFORE UPDATE ON markets WHEN NEW.state != OLD.state AND NOT (
    (OLD.state = 'UNRESOLVED' AND NEW.state IN ('PROPOSED', 'FINAL'))
    OR (OLD.state = 'PROPOSED' AND NEW.state IN ('DISPUTED', 'FINAL'))
    OR (OLD.state = 'DISPUTED' AND NEW.state = 'FINAL'))
BEGIN SELECT RAISE(ABORT, 'invalid market state transition'); END;

CREATE TRIGGER IF NOT EXISTS markets_immutable_proposal
BEFORE UPDATE ON markets WHEN OLD.state != 'UNRESOLVED' AND (
    NEW.proposed_result IS NOT OLD.proposed_result OR NEW.challenge_deadline IS NOT OLD.challenge_deadline)
BEGIN SELECT RAISE(ABORT, 'immutable proposal and challenge deadline'); END;

CREATE TRIGGER IF NOT EXISTS markets_immutable_final_result
BEFORE UPDATE ON markets WHEN OLD.state = 'FINAL' AND (
    NEW.final_result IS NOT OLD.final_result OR NEW.evidence IS NOT OLD.evidence)
BEGIN SELECT RAISE(ABORT, 'immutable final result'); END;

CREATE TRIGGER IF NOT EXISTS requests_immutable_terms
BEFORE UPDATE ON requests WHEN
    NEW.id IS NOT OLD.id OR NEW.taker IS NOT OLD.taker OR NEW.nonce IS NOT OLD.nonce
    OR NEW.terms_hash IS NOT OLD.terms_hash OR NEW.stake IS NOT OLD.stake
    OR NEW.response_deadline IS NOT OLD.response_deadline OR NEW.acceptance_deadline IS NOT OLD.acceptance_deadline
    OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'immutable request terms'); END;

CREATE TRIGGER IF NOT EXISTS requests_state_transition
BEFORE UPDATE ON requests WHEN NEW.state != OLD.state AND NOT (
    (OLD.state = 'COLLECTING' AND NEW.state IN ('OFFERED', 'REJECTED', 'EXPIRED', 'CANCELLED'))
    OR (OLD.state = 'OFFERED' AND NEW.state IN ('FILLED', 'REJECTED', 'EXPIRED', 'CANCELLED'))
    OR (OLD.state = 'FILLED' AND NEW.state = 'SETTLED'))
BEGIN SELECT RAISE(ABORT, 'invalid request state transition'); END;

CREATE TRIGGER IF NOT EXISTS requests_fixed_selection
BEFORE UPDATE ON requests WHEN OLD.selected_quote_id IS NOT NULL AND NEW.selected_quote_id IS NOT OLD.selected_quote_id
BEGIN SELECT RAISE(ABORT, 'selected quote cannot be replaced'); END;

CREATE TRIGGER IF NOT EXISTS requests_selection_belongs
BEFORE UPDATE ON requests WHEN NEW.selected_quote_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM quotes WHERE id = NEW.selected_quote_id AND request_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'selected quote belongs to another request'); END;

CREATE TRIGGER IF NOT EXISTS quotes_immutable_terms
BEFORE UPDATE ON quotes WHEN
    NEW.sequence IS NOT OLD.sequence OR NEW.id IS NOT OLD.id OR NEW.request_id IS NOT OLD.request_id
    OR NEW.maker IS NOT OLD.maker OR NEW.request_hash IS NOT OLD.request_hash
    OR NEW.replaces_quote_id IS NOT OLD.replaces_quote_id
    OR NEW.payout IS NOT OLD.payout OR NEW.price_e6 IS NOT OLD.price_e6
    OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'immutable quote terms'); END;

CREATE TRIGGER IF NOT EXISTS quotes_state_transition
BEFORE UPDATE ON quotes WHEN NEW.state != OLD.state AND NOT (
    (OLD.state = 'LIVE' AND NEW.state IN ('SELECTED', 'REJECTED', 'EXPIRED', 'CANCELLED'))
    OR (OLD.state = 'SELECTED' AND NEW.state IN ('ACCEPTED', 'REJECTED', 'EXPIRED')))
BEGIN SELECT RAISE(ABORT, 'invalid quote state transition'); END;

CREATE TRIGGER IF NOT EXISTS quotes_match_request
BEFORE INSERT ON quotes WHEN NOT EXISTS (
    SELECT 1 FROM requests r WHERE r.id = NEW.request_id AND r.terms_hash = NEW.request_hash
    AND r.stake < NEW.payout AND r.taker != NEW.maker AND NEW.expires_at <= r.acceptance_deadline)
BEGIN SELECT RAISE(ABORT, 'quote does not match request'); END;

CREATE TRIGGER IF NOT EXISTS positions_immutable_terms
BEFORE UPDATE ON positions WHEN
    NEW.id IS NOT OLD.id OR NEW.request_id IS NOT OLD.request_id OR NEW.quote_id IS NOT OLD.quote_id
    OR NEW.taker IS NOT OLD.taker OR NEW.maker IS NOT OLD.maker OR NEW.stake IS NOT OLD.stake
    OR NEW.maker_collateral IS NOT OLD.maker_collateral OR NEW.payout IS NOT OLD.payout
    OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'immutable position terms'); END;

CREATE TRIGGER IF NOT EXISTS positions_state_transition
BEFORE UPDATE ON positions WHEN NEW.state != OLD.state AND NOT (OLD.state = 'OPEN' AND NEW.state IN ('WON', 'LOST', 'VOID'))
BEGIN SELECT RAISE(ABORT, 'invalid position state transition'); END;

CREATE TRIGGER IF NOT EXISTS positions_immutable_settlement
BEFORE UPDATE ON positions WHEN OLD.settled_at IS NOT NULL AND NEW.settled_at IS NOT OLD.settled_at
BEGIN SELECT RAISE(ABORT, 'immutable settlement time'); END;

CREATE TRIGGER IF NOT EXISTS positions_match_request_quote
BEFORE INSERT ON positions WHEN NOT EXISTS (
    SELECT 1 FROM requests r JOIN quotes q ON q.request_id = r.id
    WHERE r.id = NEW.request_id AND q.id = NEW.quote_id AND r.taker = NEW.taker
    AND q.maker = NEW.maker AND r.stake = NEW.stake AND q.payout = NEW.payout
    AND r.selected_quote_id = q.id)
BEGIN SELECT RAISE(ABORT, 'position does not match accepted terms'); END;

CREATE TRIGGER IF NOT EXISTS request_legs_match_market
BEFORE INSERT ON request_legs WHEN NOT EXISTS (
    SELECT 1 FROM markets WHERE id = NEW.market_id AND terms_hash = NEW.market_terms_hash)
BEGIN SELECT RAISE(ABORT, 'leg does not match market terms'); END;

CREATE TRIGGER IF NOT EXISTS position_legs_match_request
BEFORE INSERT ON position_legs WHEN NOT EXISTS (
    SELECT 1 FROM positions p JOIN request_legs l ON l.request_id = p.request_id
    WHERE p.id = NEW.position_id AND l.leg_index = NEW.leg_index AND l.market_id = NEW.market_id
    AND l.side = NEW.side AND l.market_terms_hash = NEW.market_terms_hash)
BEGIN SELECT RAISE(ABORT, 'position leg does not match request'); END;

CREATE TRIGGER IF NOT EXISTS balances_immutable_account
BEFORE UPDATE ON balances WHEN NEW.account IS NOT OLD.account
BEGIN SELECT RAISE(ABORT, 'immutable account identity'); END;

CREATE TRIGGER IF NOT EXISTS meta_immutable_identity
BEFORE UPDATE ON meta WHEN NEW.key IS NOT OLD.key OR (OLD.key IN ('schema_version', 'operator') AND NEW.value IS NOT OLD.value)
BEGIN SELECT RAISE(ABORT, 'immutable database identity'); END;

CREATE TRIGGER IF NOT EXISTS meta_no_delete
BEFORE DELETE ON meta
BEGIN SELECT RAISE(ABORT, 'durable history cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS markets_no_delete
BEFORE DELETE ON markets
BEGIN SELECT RAISE(ABORT, 'durable history cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS requests_no_delete
BEFORE DELETE ON requests
BEGIN SELECT RAISE(ABORT, 'durable history cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS request_legs_no_delete
BEFORE DELETE ON request_legs
BEGIN SELECT RAISE(ABORT, 'durable history cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS quotes_no_delete
BEFORE DELETE ON quotes
BEGIN SELECT RAISE(ABORT, 'durable history cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS positions_no_delete
BEFORE DELETE ON positions
BEGIN SELECT RAISE(ABORT, 'durable history cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS position_legs_no_delete
BEFORE DELETE ON position_legs
BEGIN SELECT RAISE(ABORT, 'durable history cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS balances_no_delete
BEFORE DELETE ON balances
BEGIN SELECT RAISE(ABORT, 'durable history cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS journal_no_delete
BEFORE DELETE ON journal
BEGIN SELECT RAISE(ABORT, 'durable history cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS commands_no_delete
BEFORE DELETE ON commands
BEGIN SELECT RAISE(ABORT, 'durable history cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'durable history cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS request_legs_no_update
BEFORE UPDATE ON request_legs
BEGIN SELECT RAISE(ABORT, 'append-only history cannot be updated'); END;

CREATE TRIGGER IF NOT EXISTS position_legs_no_update
BEFORE UPDATE ON position_legs
BEGIN SELECT RAISE(ABORT, 'append-only history cannot be updated'); END;

CREATE TRIGGER IF NOT EXISTS journal_no_update
BEFORE UPDATE ON journal
BEGIN SELECT RAISE(ABORT, 'append-only history cannot be updated'); END;

CREATE TRIGGER IF NOT EXISTS commands_no_update
BEFORE UPDATE ON commands
BEGIN SELECT RAISE(ABORT, 'append-only history cannot be updated'); END;

CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'append-only history cannot be updated'); END;
