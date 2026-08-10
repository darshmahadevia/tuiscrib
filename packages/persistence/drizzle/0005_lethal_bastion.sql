CREATE TABLE "sticky_notes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sticky_notes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"board_id" bigint NOT NULL,
	"authored_by_user_id" bigint NOT NULL,
	"text" text NOT NULL,
	"text_version" integer DEFAULT 1 NOT NULL,
	"position_x" integer NOT NULL,
	"position_y" integer NOT NULL,
	"color" text NOT NULL,
	"stacking_order" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_edited_by_user_id" bigint NOT NULL,
	"last_edited_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sticky_notes_public_id_format_check" CHECK ("sticky_notes"."public_id" ~ '^[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "sticky_notes_text_length_check" CHECK (char_length("sticky_notes"."text") <= 2000),
	CONSTRAINT "sticky_notes_text_version_check" CHECK ("sticky_notes"."text_version" >= 1),
	CONSTRAINT "sticky_notes_position_x_check" CHECK ("sticky_notes"."position_x" >= -1000000 AND "sticky_notes"."position_x" <= 1000000),
	CONSTRAINT "sticky_notes_position_y_check" CHECK ("sticky_notes"."position_y" >= -1000000 AND "sticky_notes"."position_y" <= 1000000),
	CONSTRAINT "sticky_notes_color_check" CHECK ("sticky_notes"."color" IN ('amber', 'blue', 'cyan', 'green', 'magenta', 'red', 'violet', 'yellow')),
	CONSTRAINT "sticky_notes_stacking_order_check" CHECK ("sticky_notes"."stacking_order" >= 0 AND "sticky_notes"."stacking_order" < 500)
);
--> statement-breakpoint
ALTER TABLE "sticky_notes" ADD CONSTRAINT "sticky_notes_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sticky_notes" ADD CONSTRAINT "sticky_notes_authored_by_user_id_users_id_fk" FOREIGN KEY ("authored_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sticky_notes" ADD CONSTRAINT "sticky_notes_last_edited_by_user_id_users_id_fk" FOREIGN KEY ("last_edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sticky_notes_public_id_unique" ON "sticky_notes" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "sticky_notes_board_id_idx" ON "sticky_notes" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "sticky_notes_authored_by_user_id_idx" ON "sticky_notes" USING btree ("authored_by_user_id");--> statement-breakpoint
CREATE INDEX "sticky_notes_last_edited_by_user_id_idx" ON "sticky_notes" USING btree ("last_edited_by_user_id");