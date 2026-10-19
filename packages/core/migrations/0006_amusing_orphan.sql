CREATE TABLE "usage_hourly" (
	"hour" timestamp with time zone NOT NULL,
	"address" text NOT NULL,
	"txs" integer NOT NULL,
	"failed" integer NOT NULL,
	"gas" double precision NOT NULL,
	"fees" numeric NOT NULL,
	CONSTRAINT "usage_hourly_hour_address_pk" PRIMARY KEY("hour","address")
);
--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "usage_rolled_to" bigint;