CREATE TABLE "boards" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "boards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" bigint NOT NULL,
	"join_code_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "boards_public_id_format_check" CHECK ("boards"."public_id" ~ '^[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "boards_name_format_check" CHECK ("boards"."name" = btrim("boards"."name") AND "boards"."name" <> '' AND char_length("boards"."name") <= 80 AND position(chr(10) in "boards"."name") = 0 AND position(chr(13) in "boards"."name") = 0 AND position(chr(8232) in "boards"."name") = 0 AND position(chr(8233) in "boards"."name") = 0),
	CONSTRAINT "boards_join_code_hash_format_check" CHECK ("boards"."join_code_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"board_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "memberships_pkey" PRIMARY KEY("board_id","user_id"),
	CONSTRAINT "memberships_role_check" CHECK ("memberships"."role" IN ('owner', 'member'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "owned_board_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "boards_public_id_unique" ON "boards" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "boards_owner_user_id_idx" ON "boards" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "boards_name_idx" ON "boards" USING btree ("name");--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_one_owner_per_board" ON "memberships" USING btree ("board_id") WHERE "memberships"."role" = 'owner';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_owned_board_count_check" CHECK ("users"."owned_board_count" >= 0 AND "users"."owned_board_count" <= 20);
