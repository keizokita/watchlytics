CREATE TABLE "ingest_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "cast_names" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "credits_synced_at" timestamp with time zone;