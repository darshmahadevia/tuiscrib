CREATE TABLE "service_metadata" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "service_metadata" ("key", "value") VALUES ('service', 'tuiscrib');
