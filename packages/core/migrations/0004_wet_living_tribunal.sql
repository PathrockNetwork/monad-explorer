CREATE TABLE "block_stages" (
	"block_id" text PRIMARY KEY NOT NULL,
	"number" bigint NOT NULL,
	"hash" text,
	"miner" text,
	"proposer_id" integer,
	"tx_count" integer,
	"gas_used" bigint,
	"proposed_at" timestamp (3) with time zone,
	"voted_at" timestamp (3) with time zone,
	"finalized_at" timestamp (3) with time zone,
	"verified_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "block_traces" (
	"block_number" bigint PRIMARY KEY NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"tx_count" integer NOT NULL,
	"dependent_txs" integer NOT NULL,
	"edges" integer NOT NULL,
	"critical_path" integer NOT NULL,
	"parallelism" double precision NOT NULL,
	"internal_txs" integer NOT NULL,
	"levels" jsonb NOT NULL,
	"edge_list" jsonb NOT NULL,
	"hot" jsonb NOT NULL,
	"traced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internal_txs" (
	"tx_hash" text NOT NULL,
	"idx" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"depth" smallint NOT NULL,
	"call_type" text NOT NULL,
	"from" text NOT NULL,
	"to" text,
	"value" numeric NOT NULL,
	"gas_used" bigint,
	"error" text,
	CONSTRAINT "internal_txs_tx_hash_idx_pk" PRIMARY KEY("tx_hash","idx")
);
--> statement-breakpoint
CREATE TABLE "staking_events" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"time" timestamp with time zone,
	"kind" text NOT NULL,
	"validator_id" integer,
	"address" text,
	"amount" numeric,
	"epoch" bigint,
	"withdraw_id" smallint,
	"old_commission" double precision,
	"new_commission" double precision,
	"flags" bigint,
	CONSTRAINT "staking_events_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "reward" numeric;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "staking_history_floor" bigint;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "gas_estimate" bigint;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "call_count" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "call_depth" smallint;--> statement-breakpoint
CREATE INDEX "block_stages_number_idx" ON "block_stages" USING btree ("number");--> statement-breakpoint
CREATE INDEX "block_stages_proposed_idx" ON "block_stages" USING btree ("proposed_at");--> statement-breakpoint
CREATE INDEX "block_traces_time_idx" ON "block_traces" USING btree ("time");--> statement-breakpoint
CREATE INDEX "itx_block_idx" ON "internal_txs" USING btree ("block_number");--> statement-breakpoint
CREATE INDEX "itx_from_idx" ON "internal_txs" USING btree ("from","block_number");--> statement-breakpoint
CREATE INDEX "itx_to_idx" ON "internal_txs" USING btree ("to","block_number");--> statement-breakpoint
CREATE INDEX "staking_block_idx" ON "staking_events" USING btree ("block_number");--> statement-breakpoint
CREATE INDEX "staking_validator_idx" ON "staking_events" USING btree ("validator_id","block_number");--> statement-breakpoint
CREATE INDEX "staking_address_idx" ON "staking_events" USING btree ("address","block_number");