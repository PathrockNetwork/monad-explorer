ALTER TABLE "blocks" ADD COLUMN "proposer_id" integer;--> statement-breakpoint
ALTER TABLE "validators" ADD COLUMN "beneficiary" text;--> statement-breakpoint
CREATE INDEX "blocks_proposer_idx" ON "blocks" USING btree ("proposer_id","number");--> statement-breakpoint
CREATE INDEX "validators_beneficiary_idx" ON "validators" USING btree ("beneficiary");