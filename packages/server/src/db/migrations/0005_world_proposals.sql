PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_canon_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`world_id` text NOT NULL,
	`kind` text DEFAULT 'scene' NOT NULL,
	`scene_id` text,
	`status` text NOT NULL,
	`base_commit` text,
	`files` text NOT NULL,
	`notes` text DEFAULT '[]' NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_canon_proposals`("id", "world_id", "kind", "scene_id", "status", "base_commit", "files", "notes", "error", "created_at", "updated_at", "revision", "deleted_at") SELECT p."id", COALESCE((SELECT c."world_id" FROM `scenes` s JOIN `chats` c ON c."id" = s."chat_id" WHERE s."id" = p."scene_id"), ''), 'scene', p."scene_id", p."status", p."base_commit", p."files", p."notes", p."error", p."created_at", p."updated_at", p."revision", p."deleted_at" FROM `canon_proposals` p;--> statement-breakpoint
DROP TABLE `canon_proposals`;--> statement-breakpoint
ALTER TABLE `__new_canon_proposals` RENAME TO `canon_proposals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `proposals_scene_idx` ON `canon_proposals` (`scene_id`);--> statement-breakpoint
CREATE INDEX `proposals_world_idx` ON `canon_proposals` (`world_id`);