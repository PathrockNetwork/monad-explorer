CREATE TABLE "validators" (
	"id" integer PRIMARY KEY NOT NULL,
	"auth_address" text NOT NULL,
	"secp" text NOT NULL,
	"bls" text,
	"flags" bigint DEFAULT 0 NOT NULL,
	"stake" numeric NOT NULL,
	"consensus_stake" numeric NOT NULL,
	"snapshot_stake" numeric NOT NULL,
	"commission" double precision NOT NULL,
	"consensus_commission" double precision NOT NULL,
	"unclaimed_rewards" numeric NOT NULL,
	"in_consensus_set" boolean DEFAULT false NOT NULL,
	"in_execution_set" boolean DEFAULT false NOT NULL,
	"name" text,
	"logo" text,
	"website" text,
	"description" text,
	"x" text,
	"vdp" boolean,
	"decommissioned" boolean,
	"registry_synced_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "epoch" bigint;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "epoch_delay_period" boolean;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "validators_synced_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "validators_auth_idx" ON "validators" USING btree ("auth_address");