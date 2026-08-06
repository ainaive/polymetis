ALTER TABLE "runs" ADD COLUMN "cacheReadTokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cacheCreationTokens" integer DEFAULT 0 NOT NULL;