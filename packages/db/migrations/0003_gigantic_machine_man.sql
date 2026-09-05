CREATE TABLE IF NOT EXISTS "dead_letters" (
	"dead_letter_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue_name" text NOT NULL,
	"job_id" text NOT NULL,
	"job_data" jsonb NOT NULL,
	"failure_reason" text NOT NULL,
	"attempts_made" integer NOT NULL,
	"first_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dead_letters_queue_job_idx" ON "dead_letters" USING btree ("queue_name","job_id");