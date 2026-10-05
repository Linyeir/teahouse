-- Characters move from SQLite into world folders. Chats from v0.1 step 1 point at characters
-- that no longer exist and cannot be mapped to a world, so they are removed (pre-release).
DELETE FROM `messages`;--> statement-breakpoint
DROP TABLE `chats`;--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`world_id` text NOT NULL,
	`character_slug` text NOT NULL,
	`active_leaf_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
DROP TABLE `characters`;
