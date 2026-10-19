CREATE TABLE "blocks" (
	"number" bigint PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"parent_hash" text NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"miner" text NOT NULL,
	"gas_used" bigint NOT NULL,
	"gas_limit" bigint NOT NULL,
	"base_fee_per_gas" numeric,
	"tx_count" integer NOT NULL,
	"size" integer,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"head_number" bigint,
	"backfill_target" bigint,
	"chain_finalized" bigint,
	"active_rpc" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_transfers" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"from" text NOT NULL,
	"to" text NOT NULL,
	"value" numeric NOT NULL,
	"standard" text NOT NULL,
	CONSTRAINT "token_transfers_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"address" text PRIMARY KEY NOT NULL,
	"name" text,
	"symbol" text,
	"decimals" smallint,
	"standard" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"first_seen_block" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"hash" text PRIMARY KEY NOT NULL,
	"block_number" bigint NOT NULL,
	"tx_index" integer NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"from" text NOT NULL,
	"to" text,
	"contract_address" text,
	"value" numeric NOT NULL,
	"nonce" bigint NOT NULL,
	"type" smallint NOT NULL,
	"gas_limit" bigint NOT NULL,
	"gas_used" bigint NOT NULL,
	"effective_gas_price" numeric NOT NULL,
	"fee" numeric NOT NULL,
	"status" smallint NOT NULL,
	"method" text,
	"input_size" integer NOT NULL,
	"log_count" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "blocks_time_idx" ON "blocks" USING btree ("time");--> statement-breakpoint
CREATE INDEX "blocks_hash_idx" ON "blocks" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "blocks_miner_idx" ON "blocks" USING btree ("miner","number");--> statement-breakpoint
CREATE INDEX "transfers_block_idx" ON "token_transfers" USING btree ("block_number");--> statement-breakpoint
CREATE INDEX "transfers_from_idx" ON "token_transfers" USING btree ("from","block_number");--> statement-breakpoint
CREATE INDEX "transfers_to_idx" ON "token_transfers" USING btree ("to","block_number");--> statement-breakpoint
CREATE INDEX "transfers_token_idx" ON "token_transfers" USING btree ("token","block_number");--> statement-breakpoint
CREATE INDEX "tokens_unresolved_idx" ON "tokens" USING btree ("address") WHERE "tokens"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "txs_block_idx" ON "transactions" USING btree ("block_number","tx_index");--> statement-breakpoint
CREATE INDEX "txs_from_idx" ON "transactions" USING btree ("from","block_number");--> statement-breakpoint
CREATE INDEX "txs_to_idx" ON "transactions" USING btree ("to","block_number");