CREATE TABLE `canon_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`status` text NOT NULL,
	`base_commit` text,
	`files` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `memory_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`message_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memory_scene_idx` ON `memory_nodes` (`scene_id`);--> statement-breakpoint
CREATE INDEX `memory_message_idx` ON `memory_nodes` (`message_id`);--> statement-breakpoint
CREATE TABLE `scenes` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`number` integer NOT NULL,
	`status` text NOT NULL,
	`cast` text NOT NULL,
	`start_message_id` text,
	`closed_leaf_id` text,
	`canon_commit` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scenes_chat_idx` ON `scenes` (`chat_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `scene_id` text;--> statement-breakpoint
-- Existing chats become one active scene, cast with the chat's character.
INSERT INTO `scenes` (`id`, `chat_id`, `number`, `status`, `cast`, `start_message_id`, `created_at`, `updated_at`)
SELECT
	lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-8' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	`chats`.`id`, 1, 'active', json_array(`chats`.`character_slug`),
	(SELECT `m`.`id` FROM `messages` `m` WHERE `m`.`chat_id` = `chats`.`id` AND `m`.`parent_id` IS NULL ORDER BY `m`.`id` LIMIT 1),
	`chats`.`created_at`, `chats`.`updated_at`
FROM `chats`;
--> statement-breakpoint
UPDATE `messages` SET `scene_id` = (SELECT `s`.`id` FROM `scenes` `s` WHERE `s`.`chat_id` = `messages`.`chat_id`);
