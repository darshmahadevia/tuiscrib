ALTER TABLE "boards" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_revision_nonnegative_check" CHECK ("boards"."revision" >= 0);